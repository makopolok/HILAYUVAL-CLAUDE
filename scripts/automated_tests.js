const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

// Default to local, but can be overridden by TEST_BASE_URL env var for Heroku testing
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000'; 

async function createTestProject(projectData) {
  console.log(`Attempting to create project: ${projectData.name} at ${BASE_URL}/projects/create`);
  try {
    const response = await axios.post(`${BASE_URL}/projects/create`, projectData, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } // Express urlencoded expects this
    });
    console.log('Create Project Response Status:', response.status);
    // console.log('Create Project Response Data:', response.data); // HTML response

    // Attempt to extract project ID from the HTML response (this is fragile)
    if (response.data && typeof response.data === 'string') {
      // Try to find numeric id patterns in rendered JSON/HTML (e.g. "id":123 or data-project-id="123")
      const numericIdMatch = response.data.match(/"id"\s*:?\s*"?(\d+)"?/);
      if (numericIdMatch && numericIdMatch[1]) {
        console.log(`Extracted Project ID: ${numericIdMatch[1]}`);
        return numericIdMatch[1];
      }
      const dataAttrMatch = response.data.match(/data-project-id="(\d+)"/);
      if (dataAttrMatch && dataAttrMatch[1]) {
        console.log(`Extracted Project ID (data-attr): ${dataAttrMatch[1]}`);
        return dataAttrMatch[1];
      }
    }
    console.warn('Could not extract project ID from response.');
    return null;
  } catch (error) {
    console.error('Error creating project:', error.response ? `${error.response.status} - ${JSON.stringify(error.response.data)}` : error.message);
    return null;
  }
}

async function submitTestAudition(projectId, auditionData, videoFilePath, profilePictureFilePaths) {
  if (!projectId) {
    console.error('Cannot submit audition without a project ID.');
    return;
  }
  console.log(`Attempting to submit audition for project ID: ${projectId} at ${BASE_URL}/audition/${projectId}`);
  
  const form = new FormData();
  form.append('role', auditionData.role);
  form.append('first_name_en', auditionData.first_name_en || 'TestFirstName');
  form.append('last_name_en', auditionData.last_name_en || 'TestLastName');
  form.append('email', auditionData.email || 'test@example.com');
  form.append('phone', auditionData.phone || '1234567890');
  // Add any other required fields from your form
  // form.append('first_name_he', auditionData.first_name_he || '');
  // form.append('last_name_he', auditionData.last_name_he || '');
  // form.append('agency', auditionData.agency || '');
  // form.append('age', auditionData.age || '25');
  // form.append('height', auditionData.height || '170');
  // form.append('showreel_url', auditionData.showreel_url || '');
  // form.append('message', auditionData.message || 'Test submission');


  if (videoFilePath && fs.existsSync(videoFilePath)) {
    form.append('video', fs.createReadStream(videoFilePath), path.basename(videoFilePath));
    console.log(`Appending video file: ${videoFilePath}`);
  } else if (videoFilePath) {
    console.warn(`Video file not found: ${videoFilePath}`);
  }

  if (profilePictureFilePaths && profilePictureFilePaths.length > 0) {
    profilePictureFilePaths.forEach(pPath => {
      if (fs.existsSync(pPath)) {
        form.append('profile_pictures', fs.createReadStream(pPath), path.basename(pPath));
        console.log(`Appending profile picture file: ${pPath}`);
      } else {
        console.warn(`Profile picture file not found: ${pPath}`);
      }
    });
  }

  try {
    const response = await axios.post(`${BASE_URL}/audition/${projectId}`, form, {
      headers: {
        ...form.getHeaders(), // Important for multipart/form-data
      },
    });
    console.log('Submit Audition Response Status:', response.status);
    console.log('Submit Audition Response Data:', response.data); // HTML response
  } catch (error) {
    console.error('Error submitting audition:', error.response ? `${error.response.status} - ${JSON.stringify(error.response.data)}` : error.message);
  }
}

async function main() {
  console.log(`Starting automated tests against: ${BASE_URL}`);

  // --- Prepare dummy files ---
  const testFilesDir = path.join(__dirname, 'test_files');
  if (!fs.existsSync(testFilesDir)) {
    console.log(`Creating directory: ${testFilesDir}`);
    fs.mkdirSync(testFilesDir, { recursive: true });
  }
  const dummyVideoPath = path.join(testFilesDir, 'dummy_video.mp4');
  const dummyProfilePicPath = path.join(testFilesDir, 'dummy_profile.jpg');

  if (!fs.existsSync(dummyVideoPath)) {
    console.log(`Creating dummy video file: ${dummyVideoPath}`);
    fs.writeFileSync(dummyVideoPath, 'dummy video content for testing');
  }
  if (!fs.existsSync(dummyProfilePicPath)) {
    console.log(`Creating dummy profile picture file: ${dummyProfilePicPath}`);
    fs.writeFileSync(dummyProfilePicPath, 'dummy image content for testing');
  }
  // --- End Prepare dummy files ---

  // Test Case 1: Create a Cloudflare project and submit an audition
  console.log("\n--- Test Case 1: Cloudflare Project & Audition ---");
  const cfProjectData = {
    name: 'Automated Test CF Project',
    description: 'Test project for Cloudflare uploads (automated)',
    uploadMethod: 'cloudflare', // Explicitly 'cloudflare'
    roles: JSON.stringify([{ name: 'Lead CF Role' }, { name: 'Support CF Role' }]), // Ensure roles are stringified if sending as x-www-form-urlencoded
    director: 'Auto Test Director',
    production_company: 'Auto Test Prod Co'
  };
  // The roles need to be sent in a way that app.js expects for x-www-form-urlencoded
  // If roles is an array of objects, multer/body-parser might parse it as roles[0][name], roles[1][name]
  // Or it might expect roles as a JSON string, or repeated roles[name]=value1&roles[name]=value2
  // For simplicity, let's adjust app.js or send roles as separate fields if x-www-form-urlencoded is strict
  // The current app.js POST /projects/create expects roles like: roles[0][name]=Actor&roles[0][playlist]=...
  // Let's reformat projectData for x-www-form-urlencoded for roles
  const cfProjectFormParams = new URLSearchParams();
  cfProjectFormParams.append('name', cfProjectData.name);
  cfProjectFormParams.append('description', cfProjectData.description);
  cfProjectFormParams.append('uploadMethod', cfProjectData.uploadMethod);
  cfProjectFormParams.append('roles[0][name]', 'Lead CF Role');
  cfProjectFormParams.append('roles[1][name]', 'Support CF Role');
  cfProjectFormParams.append('director', cfProjectData.director);
  cfProjectFormParams.append('production_company', cfProjectData.production_company);


  const cfProjectId = await createTestProject(cfProjectFormParams);

  if (cfProjectId) {
    await submitTestAudition(cfProjectId, {
      role: 'Lead CF Role', // Must match one of the roles created
      first_name_en: 'CF_Test',
      last_name_en: 'User_Auto',
      email: 'cf.test.auto@example.com',
    }, dummyVideoPath, [dummyProfilePicPath]);
  } else {
    console.log("Skipping CF audition submission due to project creation failure.");
  }

  // Test Case 2: Create a YouTube project and submit an audition
  console.log("\n--- Test Case 2: YouTube Project & Audition ---");
   const ytProjectFormParams = new URLSearchParams();
  ytProjectFormParams.append('name', 'Automated Test YT Project');
  ytProjectFormParams.append('description', 'Test project for YouTube uploads (automated)');
  ytProjectFormParams.append('uploadMethod', 'youtube');
  ytProjectFormParams.append('roles[0][name]', 'Lead YT Role'); // Playlist will be auto-created
  ytProjectFormParams.append('roles[1][name]', 'Support YT Role');
  ytProjectFormParams.append('roles[1][playlist]', 'YOUR_EXISTING_YT_PLAYLIST_ID_IF_YOU_WANT_TO_TEST_WITH_ONE'); // Optional: test with existing playlist
  ytProjectFormParams.append('director', 'Auto Test Director YT');
  ytProjectFormParams.append('production_company', 'Auto Test Prod Co YT');

  const ytProjectId = await createTestProject(ytProjectFormParams);

  if (ytProjectId) {
    await submitTestAudition(ytProjectId, {
      role: 'Lead YT Role', // Must match
      first_name_en: 'YT_Test',
      last_name_en: 'User_Auto',
      email: 'yt.test.auto@example.com',
    }, dummyVideoPath, [dummyProfilePicPath]);
  } else {
    console.log("Skipping YT audition submission due to project creation failure.");
  }

  console.log("\n--- Automated tests finished ---");
}

main().catch(err => console.error("Unhandled error in main:", err));
