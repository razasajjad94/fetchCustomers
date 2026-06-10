/**
 * Azure Blob Storage settings for display image migration.
 *
 * Fill in your values before running migrate-s3-to-azure.js.
 * Connection string: Azure Portal → Storage account → Access keys → Connection string
 */
export const AZURE_BLOB_CONFIG = {
  /** Full Azure Storage connection string */
  connectionString: "",

  /** Blob container name (must already exist, or set createContainerIfMissing: true) */
  containerName: "display-images",

  /**
   * Top-level virtual folder inside the container.
   * Bulk-all path:  {blobPrefix}/{import_kiosk_id}/{filename}
   * Per-campaign:   {blobPrefix}/{sqlCampaignId}/{import_kiosk_id}/{filename}
   */
  blobPrefix: "mongo_installed_image_url",

  /** Create container on startup if it does not exist */
  createContainerIfMissing:true,
};
