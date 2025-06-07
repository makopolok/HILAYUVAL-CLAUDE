// services/youtubeUploadService.js
const { google } = require('googleapis');
const fs = require('fs');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

module.exports = {
  async handleUpload(req, res, project, selectedRole) {
    try {
      oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
      const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
      const { name, email, role } = req.body;
      const videoFile = req.file;
      // Upload video to YouTube
      const response = await youtube.videos.insert({
        part: ['snippet', 'status'],
        requestBody: {
          snippet: {
            title: `Audition: ${name} for ${role} (${project.name})`,
            description: `Audition submitted by ${name} (${email}) for role: ${role} in project: ${project.name}.`,
          },
          status: {
            privacyStatus: 'unlisted',
          },
        },
        media: {
          body: fs.createReadStream(videoFile.path),
        },
      });
      // Add video to playlist if needed
      if (selectedRole && selectedRole.playlistId) {
        await youtube.playlistItems.insert({
          part: ['snippet'],
          requestBody: {
            snippet: {
              playlistId: selectedRole.playlistId,
              resourceId: {
                kind: 'youtube#video',
                videoId: response.data.id,
              },
            },
          },
        });
      }
      res.send('Audition uploaded to YouTube successfully!');
    } catch (err) {
      console.error('YouTube upload error:', err);
      res.status(500).send('Failed to upload audition to YouTube.');
    }
  }
};
