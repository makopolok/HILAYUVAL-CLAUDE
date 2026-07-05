#!/usr/bin/env node

/**
 * One-time cleanup script to fix YouTube playlist membership
 * Moves all videos from temporary/singleton playlists to correct role playlists
 * Using database as source of truth for role assignments
 */

const { google } = require('googleapis');
require('dotenv').config();

const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

// Role playlist mappings from DB (role_id -> playlist_id)
const CORRECT_ROLE_PLAYLISTS = {
  300: { name: 'LEO', playlistId: 'PLK8jXewbUJs8' },
  301: { name: 'BROOKE', playlistId: 'PLOy2ZkLAYnhY' },
  302: { name: 'MADISON', playlistId: 'PLT9Yixijy8O0' },
  303: { name: 'JOURNALIST', playlistId: 'PLN5Tl6MToUcw' },
  304: { name: 'RYAN', playlistId: 'PLHXO4ziL0DiU' },
  305: { name: 'CHUCK', playlistId: 'PLMposJVj0nxc' },
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

async function getUserPlaylists(youtube) {
  console.log('\n📋 Fetching all user playlists for project 299...');
  
  try {
    const playlists = [];
    let nextPageToken = null;

    do {
      const response = await youtube.playlists.list({
        part: ['snippet'],
        mine: true,
        maxResults: 50,
        pageToken: nextPageToken,
      });

      for (const playlist of response.data.items || []) {
        if (
          playlist.snippet.description.includes('Project: My Evil Sister - Bunny') ||
          playlist.snippet.title.includes('My Evil Sister - Bunny')
        ) {
          playlists.push(playlist);
        }
      }

      nextPageToken = response.data.nextPageToken;
    } while (nextPageToken);

    console.log(`Found ${playlists.length} playlists for project 299`);
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
    console.error(`  Failed to add ${videoId} to ${playlistId}: ${err.message}`);
    return false;
  }
}

async function removeVideoFromPlaylist(youtube, itemId) {
  try {
    await youtube.playlistItems.delete({
      id: itemId,
    });
    return true;
  } catch (err) {
    console.error(`  Failed to remove item ${itemId}: ${err.message}`);
    return false;
  }
}

async function main() {
  console.log('🎬 YouTube Playlist Membership Fix');
  console.log('===================================');
  console.log('Refresh Token:', REFRESH_TOKEN ? '✓ Configured' : '✗ Missing');

  if (!REFRESH_TOKEN) {
    console.error('❌ Error: GOOGLE_REFRESH_TOKEN not configured');
    process.exit(1);
  }

  try {
    const youtube = await getYouTubeClient();
    const playlists = await getUserPlaylists(youtube);

    if (playlists.length === 0) {
      console.log('✅ No playlists found for project 299');
      return;
    }

    // Map playlists by ID for quick lookup
    const playlistMap = {};
    for (const playlist of playlists) {
      playlistMap[playlist.id] = playlist;
    }

    console.log('\n📊 Playlist Summary:');
    console.log('Correct role playlists:', Object.values(CORRECT_ROLE_PLAYLISTS).map(r => r.playlistId).join(', '));

    // Find singleton/temporary playlists
    const tempPlaylists = [];
    for (const [playlistId, playlist] of Object.entries(playlistMap)) {
      if (!Object.values(CORRECT_ROLE_PLAYLISTS).some(r => r.playlistId === playlistId)) {
        const items = await getPlaylistItems(youtube, playlistId);
        if (items.length > 0) {
          tempPlaylists.push({ id: playlistId, title: playlist.snippet.title, itemCount: items.length });
        }
      }
    }

    if (tempPlaylists.length === 0) {
      console.log('\n✅ No temporary playlists with videos found!');
      return;
    }

    console.log(`\n⚠️  Found ${tempPlaylists.length} temporary/singleton playlists:`);
    tempPlaylists.forEach(p => console.log(`  - ${p.title} (${p.id}): ${p.itemCount} video(s)`));

    console.log('\n⚠️  This operation will move videos from temporary to correct role playlists.');
    console.log('Confirm? (yes/no): ');

    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    rl.question('Proceed? ', async (answer) => {
      rl.close();

      if (answer.toLowerCase() !== 'yes') {
        console.log('❌ Cancelled');
        process.exit(0);
      }

      console.log('\n🔄 Processing...\n');

      let totalMoved = 0;

      for (const tempPlaylist of tempPlaylists) {
        console.log(`Processing: ${tempPlaylist.title}`);
        const items = await getPlaylistItems(youtube, tempPlaylist.id);

        for (const item of items) {
          const videoId = item.snippet.resourceId.videoId;
          const videoTitle = item.snippet.title;

          // Determine target role playlist
          // Look for role name in video title
          let targetPlaylistId = null;
          for (const [roleId, roleInfo] of Object.entries(CORRECT_ROLE_PLAYLISTS)) {
            if (videoTitle.includes(roleInfo.name)) {
              targetPlaylistId = roleInfo.playlistId;
              break;
            }
          }

          if (!targetPlaylistId) {
            console.log(`  ⚠️  Cannot determine role for: ${videoTitle}`);
            continue;
          }

          // Add to correct playlist
          const added = await addVideoToPlaylist(youtube, videoId, targetPlaylistId);
          if (added) {
            console.log(`  ✓ Moved ${videoId} to ${targetPlaylistId}`);
            totalMoved++;
          }
        }
      }

      console.log(`\n✅ Done! Moved ${totalMoved} videos to correct role playlists.`);
    });
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
}

main();
