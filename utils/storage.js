const {
  BlobServiceClient,
  BlobSASPermissions,
  generateBlobSASQueryParameters,
  SASProtocol,
  StorageSharedKeyCredential
} = require('@azure/storage-blob');

function getStorageConfig() {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const containerName = process.env.AZURE_STORAGE_CONTAINER;
  const sasExpiryMinutes = Number(process.env.AZURE_SAS_EXPIRY_MINUTES || 60);

  return {
    connectionString,
    containerName,
    sasExpiryMinutes,
    isConfigured: Boolean(connectionString && containerName)
  };
}

function parseConnectionString(connectionString) {
  return connectionString
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, pair) => {
      const separatorIndex = pair.indexOf('=');
      if (separatorIndex < 0) {
        return acc;
      }

      const key = pair.slice(0, separatorIndex);
      const value = pair.slice(separatorIndex + 1);
      acc[key] = value;
      return acc;
    }, {});
}

function getContainerClient() {
  const { connectionString, containerName, isConfigured } = getStorageConfig();

  if (!isConfigured) {
    return null;
  }

  return BlobServiceClient
    .fromConnectionString(connectionString)
    .getContainerClient(containerName);
}

async function getOrCreateContainerClient() {
  const containerClient = getContainerClient();

  if (!containerClient) {
    return null;
  }

  await containerClient.createIfNotExists();
  return containerClient;
}

function getBlobNameFromUrl(urlValue) {
  const parsedUrl = new URL(urlValue);
  const path = parsedUrl.pathname.startsWith('/') ? parsedUrl.pathname.slice(1) : parsedUrl.pathname;
  const parts = path.split('/').filter(Boolean);

  if (parts.length < 2) {
    return null;
  }

  return decodeURIComponent(parts.slice(1).join('/'));
}

function getContainerNameFromUrl(urlValue) {
  const parsedUrl = new URL(urlValue);
  const path = parsedUrl.pathname.startsWith('/') ? parsedUrl.pathname.slice(1) : parsedUrl.pathname;
  const parts = path.split('/').filter(Boolean);
  return parts[0] || null;
}

function signBlobReadUrl(urlValue) {
  if (!urlValue) {
    return urlValue;
  }

  const { connectionString, sasExpiryMinutes } = getStorageConfig();
  if (!connectionString) {
    return urlValue;
  }

  try {
    const connectionParts = parseConnectionString(connectionString);
    const accountName = connectionParts.AccountName;
    const accountKey = connectionParts.AccountKey;

    if (!accountName || !accountKey) {
      return urlValue;
    }

    const containerName = getContainerNameFromUrl(urlValue);
    const blobName = getBlobNameFromUrl(urlValue);

    if (!containerName || !blobName) {
      return urlValue;
    }

    const credential = new StorageSharedKeyCredential(accountName, accountKey);
    const now = new Date();
    const startsOn = new Date(now.getTime() - 5 * 60 * 1000);
    const expiresOn = new Date(now.getTime() + Math.max(1, sasExpiryMinutes) * 60 * 1000);

    const sasToken = generateBlobSASQueryParameters({
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse('r'),
      protocol: SASProtocol.Https,
      startsOn,
      expiresOn
    }, credential).toString();

    const parsedUrl = new URL(urlValue);
    parsedUrl.search = sasToken;
    return parsedUrl.toString();
  } catch (error) {
    return urlValue;
  }
}

function createBlobUploadSasUrl(blobName, options = {}) {
  const { connectionString, containerName, sasExpiryMinutes } = getStorageConfig();
  if (!connectionString || !containerName || !blobName) {
    return null;
  }

  try {
    const connectionParts = parseConnectionString(connectionString);
    const accountName = connectionParts.AccountName;
    const accountKey = connectionParts.AccountKey;

    if (!accountName || !accountKey) {
      return null;
    }

    const credential = new StorageSharedKeyCredential(accountName, accountKey);
    const now = new Date();
    const startsOn = new Date(now.getTime() - 5 * 60 * 1000);
    const expiresOn = new Date(
      now.getTime() + Math.max(1, Number(options.expiryMinutes || sasExpiryMinutes)) * 60 * 1000
    );

    const sasToken = generateBlobSASQueryParameters({
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse('cw'),
      protocol: SASProtocol.Https,
      startsOn,
      expiresOn
    }, credential).toString();

    const encodedBlobName = blobName
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');

    const blobUrl = `https://${accountName}.blob.core.windows.net/${containerName}/${encodedBlobName}`;
    return {
      uploadUrl: `${blobUrl}?${sasToken}`,
      blobUrl,
      expiresOn: expiresOn.toISOString()
    };
  } catch (_) {
    return null;
  }
}

module.exports = {
  getStorageConfig,
  getContainerClient,
  getOrCreateContainerClient,
  signBlobReadUrl,
  createBlobUploadSasUrl,
  getBlobNameFromUrl,
  getContainerNameFromUrl
};