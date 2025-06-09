// services/cloudflareUploadService.js
// Cloudflare Stream video upload integration
// Docs: https://developers.cloudflare.com/stream/uploading-videos/direct-creator-upload/
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const projectService = require('./projectService');

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_STREAM_API_TOKEN = process.env.CLOUDFLARE_STREAM_API_TOKEN;
const CLOUDFLARE_IMAGES_API_TOKEN = process.env.CLOUDFLARE_IMAGES_API_TOKEN;

module.exports = {
  async handleUpload(req, res, project, selectedRole) {
    try {
      const { name, email, role } = req.body;
      const videoFile = req.file;
      if (!videoFile) {
        return res.status(400).send('No video file uploaded.');
      }
      // Prepare multipart form data for Cloudflare Stream
      const uploadUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/stream`;
      const form = new FormData();
      form.append('file', fs.createReadStream(videoFile.path));
      // Add a descriptive name for easier identification in Cloudflare dashboard
      form.append('name', `${name} - ${role} - ${project.name}`);
      // Optionally, add meta fields (as JSON string)
      form.append('meta', JSON.stringify({ name, email, role, project: project.name }));
      const response = await axios.post(uploadUrl, form, {
        headers: {
          ...form.getHeaders(),
          'Authorization': `Bearer ${CLOUDFLARE_STREAM_API_TOKEN}`
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
      fs.unlinkSync(videoFile.path);
      if (response.data && response.data.result && response.data.result.uid) {
        const videoId = response.data.result.uid;
        // Store audition info in project/role
        projectService.addAuditionToProject(
          project.id,
          selectedRole.name,
          {
            name,
            email,
            videoId,
            submittedAt: new Date().toISOString()
          }
        );
        const videoUrl = `https://iframe.videodelivery.net/${videoId}`;
        res.send(`<h2>Thank you for your submission!</h2><p>Your audition has been received and uploaded to Cloudflare Stream.</p><iframe src="${videoUrl}" width="640" height="360" frameborder="0" allowfullscreen></iframe>`);
      } else {
        throw new Error('Cloudflare Stream upload failed.');
      }
    } catch (err) {
      console.error('Cloudflare upload error:', err);
      res.status(500).send('Failed to upload audition to Cloudflare Stream.');
    }
  },

  // New: uploadVideo for backend service use
  async uploadVideo(videoFile) {
    if (!videoFile) throw new Error('No video file provided.');
    if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_STREAM_API_TOKEN) {
      console.error('Cloudflare Account ID or Stream API Token is not configured.');
      throw new Error('Cloudflare Stream credentials not configured.');
    }
    const uploadUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/stream`;
    const form = new FormData();
    form.append('file', fs.createReadStream(videoFile.path));
    form.append('name', videoFile.originalname || videoFile.filename);
    try {
      const response = await axios.post(uploadUrl, form, {
        headers: {
          ...form.getHeaders(),
          'Authorization': `Bearer ${CLOUDFLARE_STREAM_API_TOKEN}`
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
      fs.unlinkSync(videoFile.path); // Move unlink to after successful upload
      if (response.data && response.data.result && response.data.result.uid) {
        return { uid: response.data.result.uid };
      } else {
        console.error('Cloudflare Stream upload failed - unexpected response structure:', response.data);
        throw new Error('Cloudflare Stream upload failed - unexpected response structure.');
      }
    } catch (error) {
      const util = require('util');
      if (error.response) {
        try {
          // Log the full response body
          console.error('Cloudflare Stream upload error (full response):', JSON.stringify(error.response.data, null, 2));
          // Log the errors array, if present
          if (error.response.data && Array.isArray(error.response.data.errors)) {
            console.error('Cloudflare Stream upload error (errors array, length ' + error.response.data.errors.length + '):');
            error.response.data.errors.forEach((errObj, idx) => {
              console.error(`Error [${idx}]:`, util.inspect(errObj, { depth: 5 }));
            });
          } else if (error.response.data && error.response.data.errors) {
            // If errors is not an array, log it directly
            console.error('Cloudflare Stream upload error (errors):', util.inspect(error.response.data.errors, { depth: 5 }));
          }
        } catch (e) {
          console.error('Failed to stringify error.response.data:', e);
        }
        // Fallback: print the whole error object for deep inspection
        console.error('Cloudflare Stream upload error (util.inspect):', util.inspect(error, { depth: 5 }));
      } else {
        console.error('No error.response present:', error);
      }
      if (fs.existsSync(videoFile.path)) {
        fs.unlinkSync(videoFile.path);
      }
      throw error;
    }
  },

  async uploadImageToCloudflareImages(imageFile) {
    if (!imageFile) throw new Error('No image file provided.');
    if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_IMAGES_API_TOKEN) {
      console.error('Cloudflare Account ID or Images API Token is not configured.');
      throw new Error('Cloudflare Images credentials not configured.');
    }

    const uploadUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/images/v1`;
    const form = new FormData();
    form.append('file', fs.createReadStream(imageFile.path));
    // Cloudflare Images API can also accept 'id', 'metadata', 'requireSignedURLs'
    // For now, we'll keep it simple. Add 'id' if you want to set a custom ID.
    // form.append('id', 'custom_image_id'); 
    // form.append('metadata', JSON.stringify({ key: 'value' }));
    // form.append('requireSignedURLs', 'false');


    try {
      console.log(`Attempting to upload image ${imageFile.originalname} to Cloudflare Images.`);
      const response = await axios.post(uploadUrl, form, {
        headers: {
          ...form.getHeaders(),
          'Authorization': `Bearer ${CLOUDFLARE_IMAGES_API_TOKEN}`
        },
        maxContentLength: Infinity, // Important for file uploads
        maxBodyLength: Infinity    // Important for file uploads
      });

      // It's good practice to delete the temporary file after upload
      if (fs.existsSync(imageFile.path)) {
        fs.unlinkSync(imageFile.path);
      }

      if (response.data && response.data.success && response.data.result) {
        console.log('Cloudflare Images upload successful:', response.data.result.id);
        // The response.data.result object contains:
        // {
        //   "id": "your_image_id",
        //   "filename": "image_name.jpg",
        //   "uploaded": "2023-10-27T12:00:00Z",
        //   "requireSignedURLs": false,
        //   "variants": [
        //     "https://imagedelivery.net/ACCOUNT_HASH/your_image_id/public",
        //     "https://imagedelivery.net/ACCOUNT_HASH/your_image_id/thumbnail"
        //     // ... other variants
        //   ]
        // }
        // We can return the ID or a specific variant URL. Let's return the ID and the public URL.
        return { 
          id: response.data.result.id, 
          url: response.data.result.variants.find(v => v.endsWith('/public')) || response.data.result.variants[0]
        };
      } else {
        console.error('Cloudflare Images upload failed - unexpected response structure:', response.data);
        throw new Error('Cloudflare Images upload failed - unexpected response structure.');
      }
    } catch (error) {
      console.error('Cloudflare API Error in uploadImageToCloudflareImages:');
      if (error.response) {
        console.error('Data:', JSON.stringify(error.response.data, null, 2));
        console.error('Status:', error.response.status);
        console.error('Headers:', error.response.headers);
        console.error('Cloudflare error details:', JSON.stringify(error.response.data, null, 2));
      } else if (error.request) {
        console.error('Request:', error.request);
      } else {
        console.error('Error Message:', error.message);
      }
      console.error('Config:', error.config);
      
      // Ensure the file is unlinked even on error
      if (fs.existsSync(imageFile.path)) {
        fs.unlinkSync(imageFile.path);
      }
      throw error; // Re-throw to be caught by the calling function
    }
  }
};
