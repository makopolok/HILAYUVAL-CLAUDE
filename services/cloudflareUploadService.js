// services/cloudflareUploadService.js
// Cloudflare Stream video upload integration
// Docs: https://developers.cloudflare.com/stream/uploading-videos/direct-creator-upload/
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const projectService = require('./projectService');

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

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
          'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`
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
  }
};
