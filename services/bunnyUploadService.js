// services/bunnyUploadService.js
// Bunny.net video and image upload integration
// Docs: https://docs.bunny.net/reference/overview

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const BUNNY_API_KEY = process.env.BUNNY_API_KEY;
const BUNNY_STORAGE_ZONE = process.env.BUNNY_STORAGE_ZONE;
const BUNNY_VIDEO_API_KEY = process.env.BUNNY_VIDEO_API_KEY;
const BUNNY_STREAM_LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID;

module.exports = {
  // Upload video to Bunny.net Stream
  async uploadVideo(videoFile) {
    if (!videoFile) throw new Error('No video file provided.');
    if (!BUNNY_STREAM_LIBRARY_ID || !BUNNY_VIDEO_API_KEY) {
      throw new Error('Bunny.net Stream credentials not configured.');
    }
    const uploadUrl = `https://video.bunnycdn.com/library/${BUNNY_STREAM_LIBRARY_ID}/videos`; // POST to create video
    try {
      // 1. Create video entry
      const createRes = await axios.post(uploadUrl, {
        title: videoFile.originalname || videoFile.filename,
      }, {
        headers: {
          'AccessKey': BUNNY_VIDEO_API_KEY,
          'Content-Type': 'application/json',
        }
      });
      const videoId = createRes.data.guid;
      // 2. Upload video file
      const uploadVideoUrl = `https://video.bunnycdn.com/library/${BUNNY_STREAM_LIBRARY_ID}/videos/${videoId}`;
      const form = new FormData();
      form.append('file', fs.createReadStream(videoFile.path));
      await axios.post(uploadVideoUrl, form, {
        headers: {
          ...form.getHeaders(),
          'AccessKey': BUNNY_VIDEO_API_KEY,
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
      fs.unlinkSync(videoFile.path);
      return { id: videoId };
    } catch (error) {
      if (fs.existsSync(videoFile.path)) fs.unlinkSync(videoFile.path);
      throw error;
    }
  },

  // Upload image to Bunny.net Storage Zone
  async uploadImage(imageFile) {
    if (!imageFile) throw new Error('No image file provided.');
    if (!BUNNY_STORAGE_ZONE || !BUNNY_API_KEY) {
      throw new Error('Bunny.net Storage Zone credentials not configured.');
    }
    const uploadUrl = `https://storage.bunnycdn.com/${BUNNY_STORAGE_ZONE}/images/${Date.now()}_${imageFile.originalname}`;
    try {
      const fileStream = fs.createReadStream(imageFile.path);
      const res = await axios.put(uploadUrl, fileStream, {
        headers: {
          'AccessKey': BUNNY_API_KEY,
          'Content-Type': imageFile.mimetype || 'application/octet-stream',
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
      fs.unlinkSync(imageFile.path);
      if (res.status === 201 || res.status === 200) {
        // Public URL: https://{pullzone}.b-cdn.net/images/{filename}
        return {
          url: `/images/${path.basename(uploadUrl)}`,
          id: path.basename(uploadUrl)
        };
      } else {
        throw new Error('Bunny.net image upload failed.');
      }
    } catch (error) {
      if (fs.existsSync(imageFile.path)) fs.unlinkSync(imageFile.path);
      throw error;
    }
  },

  // Check video processing status based on Bunny.net Stream documentation
  async getVideoStatus(videoUid) {
    if (!BUNNY_STREAM_LIBRARY_ID || !BUNNY_VIDEO_API_KEY) {
      throw new Error('Bunny.net Stream credentials not configured.');
    }
    const statusUrl = `https://video.bunnycdn.com/library/${BUNNY_STREAM_LIBRARY_ID}/videos/${videoUid}`;
    try {
      const response = await axios.get(statusUrl, {
        headers: {
          'AccessKey': BUNNY_VIDEO_API_KEY
        },
        timeout: 15000 // 15 second timeout for API calls
      });
      if (response.data) {
        const result = response.data;
        const statusState = result.status || 'unknown';
        const readyToStream = statusState === 'ready';
        // Bunny.net does not provide pctComplete, but you can add more fields if needed
        return {
          status: statusState,
          readyToStream: readyToStream,
          uid: result.guid,
          title: result.title,
          duration: result.length,
          thumbnail: result.thumbnail,
          created: result.dateUploaded
        };
      } else {
        throw new Error('Unable to get video status from Bunny.net Stream.');
      }
    } catch (error) {
      console.error('Error checking video status:', error.message);
      throw error;
    }
  },
};
