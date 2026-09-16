export interface AdfNode {
  type: string; text?: string; attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: AdfNode[]; version?: number;
}
export interface Named { id?: string; name: string }
export interface Attachment { id: string; filename: string; mimeType: string; size: number }
export interface Issue {
  key: string;
  fields: {
    summary?: string; status?: Named; issuetype?: Named; priority?: Named | null;
    labels?: string[]; fixVersions?: Named[]; description?: AdfNode | null;
    attachment?: Attachment[]; updated?: string;
  };
}
export interface Comment { id: string; author?: { displayName?: string }; created: string; body: AdfNode }
export interface CommentPage { startAt: number; total: number; comments: Comment[] }
export interface SearchPage { issues: Issue[]; isLast?: boolean; nextPageToken?: string }
export interface Transition {
  id: string; name: string; to: Named;
  fields?: Record<string, { required?: boolean; hasDefaultValue?: boolean; allowedValues?: Named[] }>;
}
