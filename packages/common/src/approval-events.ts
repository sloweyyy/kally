import { z } from "zod/v4";

export const APPROVAL_TOOL_NAMES = [
  "createJiraIssue",
  "addCommentToJiraIssue",
  "create-feature-flag",
  "update-feature-flag",
  "sf_post_comment",
  "sf_update_status",
  "sf_update_jira_link",
  "sf_update_eta",
  "sf_post_internal_note",
  "ot_update_evidence",
  "drive_create_folder",
  "drive_upload_file",
  "drive_upload_base64",
] as const;

export const CreateJiraIssueApprovalArgsSchema = z
  .object({
    projectKey: z.unknown().optional(),
    issueTypeName: z.unknown().optional(),
    summary: z.unknown().optional(),
    description: z.unknown().optional(),
  })
  .passthrough();

export const AddCommentToJiraIssueApprovalArgsSchema = z
  .object({
    issueKey: z.unknown().optional(),
    commentBody: z.unknown().optional(),
  })
  .passthrough();

export const CreateFeatureFlagApprovalArgsSchema = z
  .object({
    key: z.unknown().optional(),
    name: z.unknown().optional(),
    description: z.unknown().optional(),
    active: z.unknown().optional(),
    rolloutPercentage: z.unknown().optional(),
    filters: z.unknown().optional(),
  })
  .passthrough();

export const UpdateFeatureFlagApprovalArgsSchema = z
  .object({
    key: z.unknown().optional(),
  })
  .passthrough();

const SalesforcePostCommentApprovalArgsSchema = z
  .object({
    caseId: z.unknown().optional(),
    body: z.unknown().optional(),
  })
  .passthrough();

const SalesforceUpdateStatusApprovalArgsSchema = z
  .object({
    caseId: z.unknown().optional(),
    status: z.unknown().optional(),
  })
  .passthrough();

const SalesforceUpdateJiraLinkApprovalArgsSchema = z
  .object({
    caseId: z.unknown().optional(),
    jiraKey: z.unknown().optional(),
  })
  .passthrough();

const SalesforceUpdateEtaApprovalArgsSchema = z
  .object({
    caseId: z.unknown().optional(),
    eta: z.unknown().optional(),
  })
  .passthrough();

const SalesforcePostInternalNoteApprovalArgsSchema = z
  .object({
    caseId: z.unknown().optional(),
    body: z.unknown().optional(),
  })
  .passthrough();

const GoogleOtUpdateEvidenceApprovalArgsSchema = z
  .object({
    rowRef: z.unknown().optional(),
    column: z.unknown().optional(),
    value: z.unknown().optional(),
  })
  .passthrough();

const GoogleDriveCreateFolderApprovalArgsSchema = z
  .object({
    parentId: z.unknown().optional(),
    name: z.unknown().optional(),
  })
  .passthrough();

const GoogleDriveUploadFileApprovalArgsSchema = z
  .object({
    parentId: z.unknown().optional(),
    name: z.unknown().optional(),
    mimeType: z.unknown().optional(),
  })
  .passthrough();

const GoogleDriveUploadBase64ApprovalArgsSchema = z
  .object({
    parentId: z.unknown().optional(),
    name: z.unknown().optional(),
    mimeType: z.unknown().optional(),
  })
  .passthrough();

export const ApprovalArgsSchema = z.union([
  CreateJiraIssueApprovalArgsSchema,
  AddCommentToJiraIssueApprovalArgsSchema,
  CreateFeatureFlagApprovalArgsSchema,
  UpdateFeatureFlagApprovalArgsSchema,
  SalesforcePostCommentApprovalArgsSchema,
  SalesforceUpdateStatusApprovalArgsSchema,
  SalesforceUpdateJiraLinkApprovalArgsSchema,
  SalesforceUpdateEtaApprovalArgsSchema,
  SalesforcePostInternalNoteApprovalArgsSchema,
  GoogleOtUpdateEvidenceApprovalArgsSchema,
  GoogleDriveCreateFolderApprovalArgsSchema,
  GoogleDriveUploadFileApprovalArgsSchema,
  GoogleDriveUploadBase64ApprovalArgsSchema,
]);

const ApprovalRequiredEventBaseSchema = z.object({
  type: z.literal("approval_required"),
  actionId: z.string().min(1),
  proxyName: z.string().min(1).optional(),
});

export const ApprovalRequiredEventPayloadSchema = z.discriminatedUnion("tool", [
  ApprovalRequiredEventBaseSchema.extend({
    tool: z.literal("createJiraIssue"),
    args: CreateJiraIssueApprovalArgsSchema,
  }),
  ApprovalRequiredEventBaseSchema.extend({
    tool: z.literal("addCommentToJiraIssue"),
    args: AddCommentToJiraIssueApprovalArgsSchema,
  }),
  ApprovalRequiredEventBaseSchema.extend({
    tool: z.literal("create-feature-flag"),
    args: CreateFeatureFlagApprovalArgsSchema,
  }),
  ApprovalRequiredEventBaseSchema.extend({
    tool: z.literal("update-feature-flag"),
    args: UpdateFeatureFlagApprovalArgsSchema,
  }),
  ApprovalRequiredEventBaseSchema.extend({
    tool: z.literal("sf_post_comment"),
    args: SalesforcePostCommentApprovalArgsSchema,
  }),
  ApprovalRequiredEventBaseSchema.extend({
    tool: z.literal("sf_update_status"),
    args: SalesforceUpdateStatusApprovalArgsSchema,
  }),
  ApprovalRequiredEventBaseSchema.extend({
    tool: z.literal("sf_update_jira_link"),
    args: SalesforceUpdateJiraLinkApprovalArgsSchema,
  }),
  ApprovalRequiredEventBaseSchema.extend({
    tool: z.literal("sf_update_eta"),
    args: SalesforceUpdateEtaApprovalArgsSchema,
  }),
  ApprovalRequiredEventBaseSchema.extend({
    tool: z.literal("sf_post_internal_note"),
    args: SalesforcePostInternalNoteApprovalArgsSchema,
  }),
  ApprovalRequiredEventBaseSchema.extend({
    tool: z.literal("ot_update_evidence"),
    args: GoogleOtUpdateEvidenceApprovalArgsSchema,
  }),
  ApprovalRequiredEventBaseSchema.extend({
    tool: z.literal("drive_create_folder"),
    args: GoogleDriveCreateFolderApprovalArgsSchema,
  }),
  ApprovalRequiredEventBaseSchema.extend({
    tool: z.literal("drive_upload_file"),
    args: GoogleDriveUploadFileApprovalArgsSchema,
  }),
  ApprovalRequiredEventBaseSchema.extend({
    tool: z.literal("drive_upload_base64"),
    args: GoogleDriveUploadBase64ApprovalArgsSchema,
  }),
]);

export type ApprovalToolName = (typeof APPROVAL_TOOL_NAMES)[number];
export type ApprovalArgs = z.infer<typeof ApprovalArgsSchema>;
export type ApprovalRequiredEventPayload = z.infer<typeof ApprovalRequiredEventPayloadSchema>;
