#!/usr/bin/env node

/**
 * Recreate main role playlists on YouTube and move all videos to them
 */

const { google } = require('googleapis');
require('dotenv').config();

const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

const ROLES = {
  300: 'LEO',
  301: 'BROOKE',
  302: 'MADISON',
  303: 'JOURNALIST',
  304: 'RYAN',
  305: 'CHUCK',
};

async function getYouTubeClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_CALLBACK_URL
  );

  oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
  return google.youtube({ version: 'v3', auth: oauth2Client });
}

async function createPlaylist(youtube, title, description) {
  try {
    const response = await youtube.playlists.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title,
          description,
        },
        status: { privacyStatus: 'unlisted' },
      },
    });
    return response.data.id;
  } catch (err) {
    console.error(`Failed to create playlist: ${err.message}`);
    return null;
  }
}

async function getUserPlaylists(youtube) {
  console.log('\n📋 Fetching user playlists for project 299...');
  
  const playlists = [];
  let nextPageToken = null;

  try {
    do {
      const response = await youtube.playlists.list({
        part: ['snippet'],
        mine: true,
        maxResults: 50,
        pageToken: nextPageToken,
      });

      for (const playlist of response.data.items || []) {
        if (playlist.snippet.description.includes('Project: My Evil Sister - Bunny')) {
          playlists.push(playlist);
        }
      }

      nextPageToken = response.data.nextPageToken;
    } while (nextPageToken);

    console.log(`Found ${playlists.length} playlists`);
    return playlists;
  } catch (err) {
    console.error('Error fetching playlists:', err.message);
    return [];
  }
}

async function getPlaylistItems(youtube, playlistId) {
  try {
    const response = await youtube.playlistItems.list({
      part: ['snippet'],
      playlistId,
      maxResults: 50,
    });
    return response.data.items || [];
  } catch (err) {
    return [];
  }
}

async function addVideoToPlaylist(youtube, videoId, playlistId) {
  try {
    await youtube.playlistItems.insert({
      part: ['snippet'],
      requestBody: {
        snippet: {
          playlistId: playlistId,
          resourceId: {
            kind: 'youtube#video',
            videoId: videoId,
          },
        },
      },
    });
    return true;
  } catch (err) {
    console.error(`  Failed to add ${videoId}: ${err.message}`);
    return false;
  }
}

async function main() {
  console.log('🎬 YouTube Role Playlist Recreation & Consolidation');
  console.log('===================================================');
  console.log('Refresh Token:', REFRESH_TOKEN ? '✓' : '✗');

  if (!REFRESH_TOKEN) {
    console.error('❌ GOOGLE_REFRESH_TOKEN not configured');
    process.exit(1);
  }

  try {
    const youtube = await getYouTubeClient();
    const allPlaylists = await getUserPlaylists(youtube);

    // Find temporary/singleton playlists by role
    const tempPlaylistsByRole = {};

    for (const playlist of allPlaylists) {
      let foundRole = null;
      for (const [roleId, roleName] of Object.entries(ROLES)) {
        if (playlist.snippet.title.includes(roleName)) {
          foundRole = roleName;
          break;
        }
      }

      if (!foundRole) continue;

      if (!tempPlaylistsByRole[foundRole]) {
        tempPlaylistsByRole[foundRole] = [];
      }
      tempPlaylistsByRole[foundRole].push(playlist);
    }

    console.log('\n📊 Temporary playlists found:');
    Object.entries(tempPlaylistsByRole).forEach(([role, playlists]) => {
      console.log(`  ${role}: ${playlists.length} playlist(s)`);
    });

    console.log('\n⚠️  This will:');
    console.log('  1. Create new main playlists for each role');
    console.log('  2. Move all videos from temp playlists to main');
    console.log('  3. Update database with new playlist IDs');
    console.log('\nProceed? (yes/no): ');

    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    rl.question('', async (answer) => {
      rl.close();

      if (answer.toLowerCase() !== 'yes') {
        console.log('❌ Cancelled');
        process.exit(0);
      }

      console.log('\n🔄 Creating new main playlists...\n');

      const newPlaylistIds = {};

      for (const [roleId, roleName] of Object.entries(ROLES)) {
        const title = `${roleName} | Project: My Evil Sister - Bunny`;
        const description = `Auditions for role: ${roleName} | Project: My Evil Sister - Bunny`;

        console.log(`Creating playlist for ${roleName}...`);
        const newPlaylistId = await createPlaylist(youtube, title, description);

        if (!newPlaylistId) {
          console.log(`  ✗ Failed to create playlist`);
          continue;
        }

        newPlaylistIds[roleName] = newPlaylistId;
        console.log(`  ✓ Created: ${newPlaylistId}`);

        // Move videos from temp playlists
        if (tempPlaylistsByRole[roleName]) {
          let movedCount = 0;
          for (const tempPlaylist of tempPlaylistsByRole[roleName]) {
            const items = await getPlaylistItems(youtube, tempPlaylist.id);
            console.log(`  Moving ${items.length} video(s) from ${tempPlaylist.id}...`);

            for (const item of items) {
              const videoId = item.snippet.resourceId.videoId;
              const added = await addVideoToPlaylist(youtube, videoId, newPlaylistId);
              if (added) {
                console.log(`    ✓ Moved ${videoId}`);
                movedCount++;
              }
            }
          }
          console.log(`  Total moved: ${movedCount}`);
        }
      }

      console.log('\n✅ Playlist recreation complete!');
      console.log('\nNew playlist IDs (update database):');
      Object.entries(newPlaylistIds).forEach(([role, playlistId]) => {
        console.log(`  ${role}: ${playlistId}`);
      });
    });
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
}

main();
