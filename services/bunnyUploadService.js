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
// Optional public CDN base (e.g. https://yourpullzone.b-cdn.net)
const BUNNY_CDN_BASE_URL = process.env.BUNNY_CDN_BASE_URL?.replace(/\/$/, '');

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
      // 2. Upload video file (Bunny.net expects PUT with raw binary, not multipart/form-data)
      const uploadVideoUrl = `https://video.bunnycdn.com/library/${BUNNY_STREAM_LIBRARY_ID}/videos/${videoId}`;
      const fileStream = fs.createReadStream(videoFile.path);
      await axios.put(uploadVideoUrl, fileStream, {
        headers: {
          'AccessKey': BUNNY_VIDEO_API_KEY,
          'Content-Type': videoFile.mimetype || 'application/octet-stream',
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
          const fileName = path.basename(uploadUrl);
          // If a CDN base is configured, build absolute URL; otherwise return relative path
          const publicUrl = BUNNY_CDN_BASE_URL ? `${BUNNY_CDN_BASE_URL}/images/${fileName}` : `/images/${fileName}`;
          return {
            url: publicUrl,
            id: fileName
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
        const rawStatus = result.status; // Bunny may return numeric codes
        // Normalize status: if numeric map to human label; if string keep
        let statusState = rawStatus;
        if (typeof rawStatus === 'number') {
          // Heuristic mapping based on Bunny docs (approx):
          // 0=queued,1=processing,2=encoding,3=ready,4=ready (observed),5=failed
            const map = { 0: 'queued', 1: 'processing', 2: 'encoding', 3: 'ready', 4: 'ready', 5: 'failed' };
            statusState = map[rawStatus] || `code_${rawStatus}`;
        }
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
