import { z } from 'zod';

import type { TokenStore } from '../storage/token-store.js';

// Slack API Response Types
export interface SlackChannel {
  id: string;
  name: string;
  is_channel: boolean;
  is_group: boolean;
  is_im: boolean;
  is_mpim: boolean;
  is_private: boolean;
  created: number;
  creator: string;
  is_archived: boolean;
  is_general: boolean;
  unlinked: number;
  name_normalized: string;
  is_shared: boolean;
  is_ext_shared: boolean;
  is_org_shared: boolean;
  pending_shared: string[];
  is_pending_ext_shared: boolean;
  is_member: boolean;
  is_open: boolean;
  topic: {
    value: string;
    creator: string;
    last_set: number;
  };
  purpose: {
    value: string;
    creator: string;
    last_set: number;
  };
  previous_names: string[];
  num_members?: number;
}

export interface SlackUser {
  id: string;
  team_id: string;
  name: string;
  deleted: boolean;
  color?: string;
  real_name: string;
  tz?: string;
  tz_label?: string;
  tz_offset?: number;
  profile: {
    avatar_hash?: string;
    status_text?: string;
    status_emoji?: string;
    real_name: string;
    display_name: string;
    real_name_normalized: string;
    display_name_normalized: string;
    email?: string;
    image_original?: string;
    image_24?: string;
    image_32?: string;
    image_48?: string;
    image_72?: string;
    image_192?: string;
    image_512?: string;
    team?: string;
  };
  is_admin?: boolean;
  is_owner?: boolean;
  is_primary_owner?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  is_bot?: boolean;
  updated: number;
  has_2fa?: boolean;
}

export interface SlackMessage {
  type: string;
  ts: string;
  user?: string;
  bot_id?: string;
  text: string;
  thread_ts?: string;
  reply_count?: number;
  replies?: Array<{
    user: string;
    ts: string;
  }>;
  subscribed?: boolean;
  last_read?: string;
  unread_count?: number;
  attachments?: any[];
  blocks?: any[];
  reactions?: Array<{
    name: string;
    count: number;
    users: string[];
  }>;
}

export interface SlackFile {
  id: string;
  created: number;
  timestamp: number;
  name: string;
  title: string;
  mimetype: string;
  filetype: string;
  pretty_type: string;
  user: string;
  editable: boolean;
  size: number;
  mode: string;
  is_external: boolean;
  external_type: string;
  is_public: boolean;
  public_url_shared: boolean;
  display_as_bot: boolean;
  username: string;
  url_private: string;
  url_private_download: string;
  permalink: string;
  permalink_public: string;
  edit_link: string;
  preview: string;
  preview_highlight: string;
  lines: number;
  lines_more: number;
  preview_is_truncated: boolean;
  channels: string[];
  groups: string[];
  ims: string[];
  initial_comment?: {
    id: string;
    created: number;
    timestamp: number;
    user: string;
    is_intro: boolean;
    comment: string;
  };
}

// Validation Schemas using Zod
export const SlackChannelCreateSchema = z.object({
  name: z.string().min(1).max(21),
  is_private: z.boolean().optional(),
});

export const SlackMessageSendSchema = z.object({
  channel: z.string().min(1),
  text: z.string().min(1),
  thread_ts: z.string().optional(),
  reply_broadcast: z.boolean().optional(),
  unfurl_links: z.boolean().optional(),
  unfurl_media: z.boolean().optional(),
});

export const SlackFileUploadSchema = z.object({
  channels: z.string().optional(),
  content: z.string().optional(),
  file: z.string().optional(),
  filename: z.string().optional(),
  filetype: z.string().optional(),
  initial_comment: z.string().optional(),
  thread_ts: z.string().optional(),
  title: z.string().optional(),
});

export const FileFilterSchema = z.object({
  user: z.string().optional(),
  channel: z.string().optional(),
  ts_from: z.string().optional(),
  ts_to: z.string().optional(),
  types: z.array(z.string()).optional(),
});

export const MessageFilterSchema = z.object({
  user: z.string().optional(),
  after: z.string().optional(),
  before: z.string().optional(),
  inclusive: z.boolean().optional().default(true),
  has_reactions: z.boolean().optional(),
  has_attachments: z.boolean().optional(),
  is_thread: z.boolean().optional(),
});

export const SlackUserSearchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().min(1).max(100).optional(),
});

// OAuth Types
export interface SlackOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  userScopes?: string[];
  tokenStore?: TokenStore;
}

export interface SlackTokens {
  access_token: string;
  token_type: string;
  scope: string;
  bot_user_id: string;
  app_id: string;
  team: {
    id: string;
    name: string;
  };
  enterprise?: {
    id: string;
    name: string;
  };
  authed_user: {
    id: string;
    scope: string;
    access_token: string;
    token_type: string;
  };
}

// Workflow Types
export interface SlackWorkflow {
  id: string;
  name: string;
  description: string;
  trigger: {
    type: 'schedule' | 'event' | 'webhook';
    config: Record<string, any>;
  };
  steps: Array<{
    type: string;
    config: Record<string, any>;
  }>;
  enabled: boolean;
  created: number;
  updated: number;
}

export type SlackEventType =
  | 'message'
  | 'channel_created'
  | 'channel_deleted'
  | 'channel_rename'
  | 'member_joined_channel'
  | 'member_left_channel'
  | 'file_shared'
  | 'reaction_added'
  | 'reaction_removed'
  | 'user_change';

export interface SlackWebhookEvent {
  token: string;
  team_id: string;
  api_app_id: string;
  event: {
    type: SlackEventType;
    [key: string]: any;
  };
  type: string;
  event_id: string;
  event_time: number;
}

export type SlackAPIMethod =
  | 'conversations.list'
  | 'conversations.create'
  | 'conversations.info'
  | 'conversations.join'
  | 'conversations.leave'
  | 'conversations.archive'
  | 'conversations.unarchive'
  | 'conversations.setTopic'
  | 'conversations.setPurpose'
  | 'conversations.invite'
  | 'conversations.members'
  | 'conversations.history'
  | 'conversations.replies'
  | 'chat.postMessage'
  | 'chat.update'
  | 'chat.delete'
  | 'chat.getPermalink'
  | 'users.list'
  | 'users.info'
  | 'users.getPresence'
  | 'users.setPresence'
  | 'users.profile.get'
  | 'users.profile.set'
  | 'users.lookupByEmail'
  | 'users.conversations'
  | 'usergroups.list'
  | 'team.info'
  | 'files.upload'
  | 'files.info'
  | 'files.list'
  | 'files.delete'
  | 'files.sharedPublicURL'
  | 'files.revokePublicURL'
  | 'files.comments.add'
  | 'search.messages'
  | 'reactions.add'
  | 'reactions.remove'
  | 'auth.test';
