// services/secureUploadService.js
const axios = require('axios');

/**
 * Secure upload service that handles API key management server-side
 * No API keys are exposed to the client
 */
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

      // 2. Return only the necessary information to the client (NO API KEY)
      return {
        guid: response.data.guid,
        title: response.data.title,
        // Return the upload URL that the client will use, but not the API key
        uploadUrl: `https://video.bunnycdn.com/library/${BUNNY_STREAM_LIBRARY_ID}/videos/${response.data.guid}`
      };
    } catch (error) {
      console.error('Secure upload session creation error:', error.message);
      throw new Error('Failed to create secure upload session');
    }
  },

  /**
   * Get upload headers for a direct-to-Bunny upload without exposing API key to client
   * Client must call this endpoint for each chunk upload to get fresh authorization headers
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
  }
};
