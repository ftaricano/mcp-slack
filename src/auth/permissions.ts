import { AuthError } from '../errors/index.js';
import { logger, logAudit } from '../utils/logger.js';
import { slackClientManager } from '../utils/slack-client.js';

export interface Permission {
  scope: string;
  resource: string;
  action: string;
  required: boolean;
}

export interface PermissionCheck {
  granted: boolean;
  missing?: string[];
  reason?: string;
}

export interface UserPermissions {
  userId: string;
  workspaceId: string;
  isAdmin: boolean;
  isOwner: boolean;
  isPrimaryOwner: boolean;
  isRestricted: boolean;
  isUltraRestricted: boolean;
  scopes: string[];
  updatedAt: number;
}

export class PermissionManager {
  private permissionCache: Map<string, UserPermissions> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  private readonly cleanupTimer: NodeJS.Timeout;

  constructor() {
    // Cleanup cache periodically. unref() so the timer never holds the event
    // loop open during graceful shutdown.
    this.cleanupTimer = setInterval(() => this.cleanupCache(), 10 * 60 * 1000);
    this.cleanupTimer.unref();
    logger.info('PermissionManager initialized');
  }

  // Define required permissions for different operations
  private readonly OPERATION_PERMISSIONS: Record<string, Permission[]> = {
    send_message: [{ scope: 'chat:write', resource: 'messages', action: 'create', required: true }],
    create_channel: [
      { scope: 'channels:write', resource: 'channels', action: 'create', required: true },
    ],
    list_channels: [
      { scope: 'channels:read', resource: 'channels', action: 'read', required: true },
    ],
    get_channel_info: [
      { scope: 'channels:read', resource: 'channels', action: 'read', required: true },
    ],
    list_users: [{ scope: 'users:read', resource: 'users', action: 'read', required: true }],
    get_user_info: [{ scope: 'users:read', resource: 'users', action: 'read', required: true }],
    upload_file: [{ scope: 'files:write', resource: 'files', action: 'create', required: true }],
    read_file: [{ scope: 'files:read', resource: 'files', action: 'read', required: true }],
    search_messages: [
      { scope: 'search:read', resource: 'messages', action: 'search', required: true },
    ],
    get_channel_history: [
      { scope: 'channels:history', resource: 'messages', action: 'read', required: true },
    ],
    add_reaction: [
      { scope: 'reactions:write', resource: 'reactions', action: 'create', required: true },
    ],
    remove_reaction: [
      { scope: 'reactions:write', resource: 'reactions', action: 'delete', required: true },
    ],
    create_workflow: [
      { scope: 'workflow.steps:execute', resource: 'workflows', action: 'create', required: true },
    ],
    manage_users: [{ scope: 'admin', resource: 'users', action: 'manage', required: true }],
  };

  // Check if user has permission for operation
  async checkPermission(
    workspaceId: string,
    userId: string,
    operation: string,
  ): Promise<PermissionCheck> {
    try {
      const userPermissions = await this.getUserPermissions(workspaceId, userId);
      const requiredPermissions = this.OPERATION_PERMISSIONS[operation];

      if (!requiredPermissions) {
        logger.warn('Unknown operation for permission check', { operation });
        return { granted: false, reason: `Unknown operation: ${operation}` };
      }

      const missingPermissions: string[] = [];

      for (const permission of requiredPermissions) {
        if (!this.hasScope(userPermissions, permission.scope)) {
          missingPermissions.push(permission.scope);
        }

        // Special checks for admin operations
        if (permission.scope === 'admin' && !userPermissions.isAdmin) {
          missingPermissions.push('admin privileges');
        }
      }

      const granted = missingPermissions.length === 0;

      logAudit({
        user: userId,
        action: 'permission_check',
        resource: `workspace:${workspaceId}`,
        details: {
          operation,
          granted,
          missing_permissions: missingPermissions,
        },
        status: granted ? 'success' : 'warning',
      });

      return {
        granted,
        ...(missingPermissions.length > 0 && { missing: missingPermissions }),
      };
    } catch (error) {
      logger.error('Permission check failed', {
        workspaceId,
        userId,
        operation,
        error: (error as Error).message,
      });

      return {
        granted: false,
        reason: `Permission check failed: ${(error as Error).message}`,
      };
    }
  }

  // Get user permissions with caching
  async getUserPermissions(workspaceId: string, userId: string): Promise<UserPermissions> {
    const cacheKey = `${workspaceId}:${userId}`;
    const cached = this.permissionCache.get(cacheKey);

    if (cached && Date.now() - cached.updatedAt < this.CACHE_TTL) {
      return cached;
    }

    try {
      const userInfo = await slackClientManager.apiCall(workspaceId, 'users.info', {
        user: userId,
      });

      if (!userInfo.ok || !userInfo.user) {
        throw new Error('Failed to fetch user information');
      }

      const user = userInfo.user;
      const tokens = slackClientManager.getTokens(workspaceId);

      const permissions: UserPermissions = {
        userId,
        workspaceId,
        isAdmin: user.is_admin || false,
        isOwner: user.is_owner || false,
        isPrimaryOwner: user.is_primary_owner || false,
        isRestricted: user.is_restricted || false,
        isUltraRestricted: user.is_ultra_restricted || false,
        scopes: tokens.scope.split(','),
        updatedAt: Date.now(),
      };

      this.permissionCache.set(cacheKey, permissions);
      return permissions;
    } catch (error) {
      logger.error('Failed to get user permissions', {
        workspaceId,
        userId,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  // Check if user has specific scope
  private hasScope(permissions: UserPermissions, requiredScope: string): boolean {
    // Admin users have all permissions
    if (permissions.isAdmin) {
      return true;
    }

    // Check direct scope match
    if (permissions.scopes.includes(requiredScope)) {
      return true;
    }

    // Map: requiredScope -> list of scopes that imply (are broader than) it.
    // E.g. having `channels:write` also satisfies `channels:read`. Direction
    // matters: write implies read, NOT the other way around. The previous
    // mapping had the keys/values reversed and silently granted write
    // operations to read-only tokens.
    const scopeHierarchy: Record<string, string[]> = {
      'channels:read': ['channels:write'],
      'files:read': ['files:write'],
      'users:read': ['users:write'],
      'reactions:read': ['reactions:write'],
      // Sub-shapes of chat:write all satisfy a chat:write requirement.
      'chat:write': ['chat:write:user', 'chat:write:bot'],
    };

    const broaderScopes = scopeHierarchy[requiredScope] || [];
    if (permissions.scopes.some((scope) => broaderScopes.includes(scope))) {
      return true;
    }

    // Admin scope on the token is treated as a wildcard, but ONLY in
    // conjunction with the user's is_admin flag (handled at the caller).
    // We keep the literal `admin` scope check here for backwards compat with
    // tokens that explicitly carry the `admin` scope string.
    if (permissions.scopes.includes('admin')) {
      return true;
    }

    return false;
  }

  // Require permission (throws if not granted)
  async requirePermission(workspaceId: string, userId: string, operation: string): Promise<void> {
    const check = await this.checkPermission(workspaceId, userId, operation);

    if (!check.granted) {
      const message = `Permission denied for operation '${operation}'${
        check.missing ? ': missing ' + check.missing.join(', ') : ''
      }${check.reason ? ': ' + check.reason : ''}`;

      throw new AuthError(message);
    }
  }

  // Check multiple permissions at once
  async checkMultiplePermissions(
    workspaceId: string,
    userId: string,
    operations: string[],
  ): Promise<Record<string, PermissionCheck>> {
    const results: Record<string, PermissionCheck> = {};

    for (const operation of operations) {
      results[operation] = await this.checkPermission(workspaceId, userId, operation);
    }

    return results;
  }

  // Get available operations for user
  async getAvailableOperations(workspaceId: string, userId: string): Promise<string[]> {
    const operations = Object.keys(this.OPERATION_PERMISSIONS);
    const results = await this.checkMultiplePermissions(workspaceId, userId, operations);

    return operations.filter((op) => results[op]?.granted);
  }

  // Invalidate cached permissions
  invalidateUserCache(workspaceId: string, userId?: string): void {
    if (userId) {
      const cacheKey = `${workspaceId}:${userId}`;
      this.permissionCache.delete(cacheKey);
      logger.debug('Invalidated permission cache for user', { workspaceId, userId });
    } else {
      // Invalidate all users for workspace
      const keysToDelete = Array.from(this.permissionCache.keys()).filter((key) =>
        key.startsWith(`${workspaceId}:`),
      );

      keysToDelete.forEach((key) => this.permissionCache.delete(key));
      logger.debug('Invalidated permission cache for workspace', {
        workspaceId,
        count: keysToDelete.length,
      });
    }
  }

  // Clean up expired cache entries
  private cleanupCache(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, permissions] of this.permissionCache.entries()) {
      if (now - permissions.updatedAt > this.CACHE_TTL) {
        this.permissionCache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug('Cleaned up expired permission cache entries', { count: cleaned });
    }
  }

  // Add custom operation permission
  addOperationPermission(operation: string, permissions: Permission[]): void {
    this.OPERATION_PERMISSIONS[operation] = permissions;
    logger.debug('Added custom operation permission', { operation, permissions });
  }

  // Remove operation permission
  removeOperationPermission(operation: string): void {
    delete this.OPERATION_PERMISSIONS[operation];
    logger.debug('Removed operation permission', { operation });
  }

  // Get all registered operations
  getRegisteredOperations(): string[] {
    return Object.keys(this.OPERATION_PERMISSIONS);
  }

  // Get permission requirements for operation
  getOperationRequirements(operation: string): Permission[] | undefined {
    return this.OPERATION_PERMISSIONS[operation];
  }

  // Validate workspace access
  async validateWorkspaceAccess(workspaceId: string): Promise<boolean> {
    try {
      const workspaces = slackClientManager.listWorkspaces();
      if (!workspaces.includes(workspaceId)) {
        return false;
      }

      return await slackClientManager.testConnection(workspaceId);
    } catch (error) {
      logger.error('Workspace access validation failed', {
        workspaceId,
        error: (error as Error).message,
      });
      return false;
    }
  }

  // Get permission summary for user
  async getPermissionSummary(
    workspaceId: string,
    userId: string,
  ): Promise<{
    user: UserPermissions;
    availableOperations: string[];
    totalOperations: number;
    permissionLevel: 'admin' | 'regular' | 'restricted' | 'ultra_restricted';
  }> {
    const user = await this.getUserPermissions(workspaceId, userId);
    const availableOperations = await this.getAvailableOperations(workspaceId, userId);

    let permissionLevel: 'admin' | 'regular' | 'restricted' | 'ultra_restricted' = 'regular';

    if (user.isAdmin) {
      permissionLevel = 'admin';
    } else if (user.isUltraRestricted) {
      permissionLevel = 'ultra_restricted';
    } else if (user.isRestricted) {
      permissionLevel = 'restricted';
    }

    return {
      user,
      availableOperations,
      totalOperations: Object.keys(this.OPERATION_PERMISSIONS).length,
      permissionLevel,
    };
  }
}

// Singleton instance
export const permissionManager = new PermissionManager();

// Helper function for middleware
export function requirePermissionMiddleware(operation: string) {
  return async (workspaceId: string, userId: string) => {
    await permissionManager.requirePermission(workspaceId, userId, operation);
  };
}
