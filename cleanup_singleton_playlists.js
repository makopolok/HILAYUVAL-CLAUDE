#!/usr/bin/env node

/**
 * One-time cleanup script to consolidate singleton YouTube playlists
 * into the main role playlists for project 299 (My Evil Sister - Bunny)
 * 
 * This script:
 * 1. Finds all single-video playlists created for project 299
 * 2. Moves videos from singleton playlists to the correct role playlist
 * 3. Deletes the now-empty singleton playlists
 * 
 * Usage: node cleanup_singleton_playlists.js
 */

const { google } = require('googleapis');
const fs = require('fs');
require('dotenv').config();

const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const PROJECT_ID = 299; // My Evil Sister - Bunny

// Role playlist mappings (from DB)
const ROLE_PLAYLISTS = {
  'BROOKE': 'PLOy2ZkLAYnhY',
  'CHUCK': 'PLMposJVj0nxc',
  'JOURNALIST': 'PLN5Tl6MToUcw',
  'LEO': 'PLK8jXewbUJs8',
  'MADISON': 'PLT9Yixijy8O0',
  'RYAN': 'PLHXO4ziL0DiU',
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

async function getSingletonPlaylists(youtube) {
  console.log('\n📋 Finding singleton playlists (1 video each)...');
  
  try {
    const response = await youtube.playlists.list({
      part: ['snippet'],
      mine: true,
      maxResults: 50,
    });

    const singletons = [];

    for (const playlist of response.data.items || []) {
      // Only process playlists for project 299 roles
      const matchesRole = Object.keys(ROLE_PLAYLISTS).some(role => 
        playlist.snippet.title.includes(role) && playlist.snippet.description.includes('Project: My Evil Sister - Bunny')
      );

      if (!matchesRole) continue;

      // Get video count for this playlist
      const videoCount = await getPlaylistVideoCount(youtube, playlist.id);

      if (videoCount === 1) {
        const role = Object.keys(ROLE_PLAYLISTS).find(r => playlist.snippet.title.includes(r));
        singletons.push({
          playlistId: playlist.id,
          title: playlist.snippet.title,
          role: role || 'UNKNOWN',
          videoCount,
        });
      }
    }

    console.log(`Found ${singletons.length} singleton playlists:`);
    singletons.forEach(p => console.log(`  - ${p.role}: ${p.playlistId}`));

    return singletons;
  } catch (err) {
    console.error('Error finding singleton playlists:', err.message);
    return [];
  }
}

async function getPlaylistVideoCount(youtube, playlistId) {
  try {
    const response = await youtube.playlistItems.list({
      part: ['id'],
      playlistId,
      maxResults: 1,
    });
    return response.data.pageInfo.totalResults || 0;
  } catch (err) {
    console.error(`Error getting video count for ${playlistId}:`, err.message);
    return 0;
  }
}

async function getPlaylistVideos(youtube, playlistId) {
  try {
    const response = await youtube.playlistItems.list({
      part: ['snippet'],
      playlistId,
      maxResults: 50,
    });
    return response.data.items || [];
  } catch (err) {
    console.error(`Error getting videos from ${playlistId}:`, err.message);
    return [];
  }
}

async function moveVideoToPlaylist(youtube, videoId, targetPlaylistId) {
  try {
    await youtube.playlistItems.insert({
      part: ['snippet'],
      requestBody: {
        snippet: {
          playlistId: targetPlaylistId,
          resourceId: {
            kind: 'youtube#video',
            videoId: videoId,
          },
        },
      },
    });
    console.log(`  ✓ Moved video ${videoId} to ${targetPlaylistId}`);
    return true;
  } catch (err) {
    console.error(`  ✗ Failed to move video ${videoId}: ${err.message}`);
    return false;
  }
}

async function deletePlaylist(youtube, playlistId) {
  try {
    await youtube.playlists.delete({
      id: playlistId,
    });
    console.log(`  ✓ Deleted singleton playlist ${playlistId}`);
    return true;
  } catch (err) {
    console.error(`  ✗ Failed to delete playlist ${playlistId}: ${err.message}`);
    return false;
  }
}

async function consolidatePlaylist(youtube, singletonPlaylist) {
  const { playlistId, role } = singletonPlaylist;
  const targetPlaylistId = ROLE_PLAYLISTS[role];

  if (!targetPlaylistId) {
    console.log(`⚠️  No target playlist found for role: ${role}`);
    return false;
  }

  console.log(`\n🔄 Processing ${role} singleton (${playlistId})...`);

  // Get all videos from singleton
  const videos = await getPlaylistVideos(youtube, playlistId);
  console.log(`  Found ${videos.length} video(s) to move`);

  // Move each video to the target playlist
  let successCount = 0;
  for (const item of videos) {
    const videoId = item.snippet.resourceId.videoId;
    const success = await moveVideoToPlaylist(youtube, videoId, targetPlaylistId);
    if (success) successCount++;
  }

  // Delete the singleton playlist
  if (successCount === videos.length) {
    await deletePlaylist(youtube, playlistId);
    return true;
  }

  console.log(`  ⚠️  Only ${successCount}/${videos.length} videos moved. Not deleting playlist.`);
  return false;
}

async function main() {
  console.log('🎬 YouTube Singleton Playlist Consolidation Tool');
  console.log('================================================');
  console.log(`Target Project: ${PROJECT_ID} (My Evil Sister - Bunny)`);
  console.log(`Refresh Token: ${REFRESH_TOKEN ? '✓ Configured' : '✗ Missing'}`);

  if (!REFRESH_TOKEN) {
    console.error('\n❌ Error: GOOGLE_REFRESH_TOKEN not configured in .env');
    process.exit(1);
  }

  try {
    const youtube = await getYouTubeClient();

    // Find singleton playlists
    const singletons = await getSingletonPlaylists(youtube);

    if (singletons.length === 0) {
      console.log('\n✅ No singleton playlists found. Nothing to consolidate!');
      return;
    }

    // Confirm with user
    console.log(`\n⚠️  This will move ${singletons.length} videos and delete ${singletons.length} playlists.`);
    console.log('Type "yes" to confirm: ');

    // For non-interactive mode, uncomment the line below for automated execution
    // const confirmed = 'yes';
    
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    rl.question('Confirm? (yes/no): ', async (answer) => {
      rl.close();

      if (answer.toLowerCase() !== 'yes') {
        console.log('❌ Cancelled.');
        process.exit(0);
      }

      // Process each singleton
      let consolidatedCount = 0;
      for (const singleton of singletons) {
        const success = await consolidatePlaylist(youtube, singleton);
        if (success) consolidatedCount++;
      }

      console.log(`\n✅ Consolidation complete! ${consolidatedCount}/${singletons.length} playlists processed.`);
    });
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
}

main();
