// services/secureUploadService.js
const axios = require('axios');
const crypto = require('crypto');

/**
 * Secure upload service that handles API key management server-side
 * No API keys are exposed to the client
 */

// In-memory token store (consider using Redis in production)
const tokenStore = {};

// Clean expired tokens periodically
setInterval(() => {
  const now = Date.now();
  Object.keys(tokenStore).forEach(token => {
    if (tokenStore[token].expiresAt < now) {
      delete tokenStore[token];
    }
  });
}, 60000); // Clean every minute

module.exports = {
  /**
   * Creates a Bunny video entry and returns a signed upload URL with temporary credentials
   * that can be used by the frontend to upload directly to Bunny.net without exposing the API key
   */
  async createSecureUploadSession(title) {
    const BUNNY_STREAM_LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID;
    const BUNNY_VIDEO_API_KEY = process.env.BUNNY_VIDEO_API_KEY;
    
    if (!BUNNY_STREAM_LIBRARY_ID || !BUNNY_VIDEO_API_KEY) {
      throw new Error('Bunny.net Stream credentials not configured.');
    }

    try {
      // 1. Create a new video entry in Bunny.net
      const createUrl = `https://video.bunnycdn.com/library/${BUNNY_STREAM_LIBRARY_ID}/videos`;
      const payload = { title: title || `upload_${Date.now()}` };
      const response = await axios.post(createUrl, payload, {
        headers: {
          'AccessKey': BUNNY_VIDEO_API_KEY,
          'Content-Type': 'application/json'
        }
      });

      if (!response || !response.data || !response.data.guid) {
        throw new Error('Failed to create Bunny Stream video.');
      }

      // 2. Generate a secure token for this upload
      const token = crypto.randomBytes(32).toString('hex');
      const tokenExpires = Date.now() + (30 * 60 * 1000); // 30 minutes
      
      // Store token with video GUID
      tokenStore[token] = {
        videoGuid: response.data.guid,
        expiresAt: tokenExpires
      };

      // 3. Return only the necessary information to the client (NO API KEY)
      return {
        guid: response.data.guid,
        title: response.data.title,
        // Include the upload endpoint on our server, not direct to Bunny
        uploadUrl: `/api/secure-upload/${response.data.guid}`,
        // Include secure temporary token
        uploadToken: token,
        tokenExpires
      };
    } catch (error) {
      console.error('Secure upload session creation error:', error.message);
      throw new Error('Failed to create secure upload session');
    }
  },

  /**
   * Verify a token is valid for a specific video GUID
   * Used to authenticate upload requests
   */
  async verifyUploadToken(videoGuid, token) {
    if (!token || !videoGuid) {
      return false;
    }
    
    const tokenData = tokenStore[token];
    if (!tokenData) {
      return false;
    }
    
    if (tokenData.expiresAt < Date.now()) {
      delete tokenStore[token];
      return false;
    }
    
    return tokenData.videoGuid === videoGuid;
  },

  /**
   * Proxy an upload request to Bunny.net with server-side authentication
   * @param {string} videoGuid - The video GUID
   * @param {ReadableStream} dataStream - The request data stream to proxy
   * @param {Object} headers - Headers to include in the proxied request
   */
  async proxyUpload(videoGuid, dataStream, headers = {}) {
    const BUNNY_STREAM_LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID;
    const BUNNY_VIDEO_API_KEY = process.env.BUNNY_VIDEO_API_KEY;
    
    if (!BUNNY_STREAM_LIBRARY_ID || !BUNNY_VIDEO_API_KEY || !videoGuid) {
      throw new Error('Missing required configuration or parameters');
    }
    
    const uploadUrl = `https://video.bunnycdn.com/library/${BUNNY_STREAM_LIBRARY_ID}/videos/${videoGuid}`;
    
    try {
      // Forward the request to Bunny.net with our server's API key
      const response = await axios({
        method: 'PUT',
        url: uploadUrl,
        data: dataStream,
        headers: {
          'AccessKey': BUNNY_VIDEO_API_KEY,
          'Content-Type': headers.contentType || 'application/octet-stream',
          ...(headers.contentLength && { 'Content-Length': headers.contentLength }),
          ...(headers.contentRange && { 'Content-Range': headers.contentRange })
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });
      
      return {
        status: response.status,
        data: response.data
      };
    } catch (error) {
      console.error('Proxy upload error:', error.message);
      throw new Error('Failed to proxy upload to Bunny.net');
    }
  },

  /**
   * Get upload headers for a direct-to-Bunny upload without exposing API key to client
   */
  getSecureUploadHeaders(videoGuid) {
    const BUNNY_VIDEO_API_KEY = process.env.BUNNY_VIDEO_API_KEY;
    
    if (!BUNNY_VIDEO_API_KEY) {
      throw new Error('Bunny.net Stream API key not configured.');
    }

    // Return headers as an object that will be used by the server to sign requests
    // These headers are NEVER exposed to the client directly
    return {
      'AccessKey': BUNNY_VIDEO_API_KEY
    };
  },
  
  /**
   * Check the status of a video on Bunny.net
   * @param {string} videoGuid - The video GUID
   */
  async getVideoStatus(videoGuid) {
    const BUNNY_STREAM_LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID;
    const BUNNY_VIDEO_API_KEY = process.env.BUNNY_VIDEO_API_KEY;
    
    if (!BUNNY_STREAM_LIBRARY_ID || !BUNNY_VIDEO_API_KEY || !videoGuid) {
      throw new Error('Missing required configuration or parameters');
    }
    
    try {
      const response = await axios.get(
        `https://video.bunnycdn.com/library/${BUNNY_STREAM_LIBRARY_ID}/videos/${videoGuid}`, {
          headers: {
            'AccessKey': BUNNY_VIDEO_API_KEY
          }
        }
      );
      
      return {
        guid: response.data.guid,
        title: response.data.title,
        status: response.data.status,
        encodingProgress: response.data.encodingProgress,
        length: response.data.length,
        thumbnailUrl: response.data.thumbnailUrl,
        created: response.data.dateUploaded
      };
    } catch (error) {
      console.error('Video status check error:', error.message);
      throw new Error('Failed to check video status');
    }
  }
};
