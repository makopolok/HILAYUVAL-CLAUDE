// services/projectService.js
const fs = require('fs');
const path = require('path');

const PROJECTS_FILE = path.join(__dirname, '../data/projects.json');

function readProjects() {
  try {
    const data = fs.readFileSync(PROJECTS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
}

function writeProjects(projects) {
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
}

function getAllProjects() {
  return readProjects();
}

function getProjectById(id) {
  return readProjects().find(p => p.id === id);
}

function addProject(project) {
  const projects = readProjects();
  projects.push(project);
  writeProjects(projects);
}

function updateProject(id, update) {
  const projects = readProjects();
  const idx = projects.findIndex(p => p.id === id);
  if (idx !== -1) {
    projects[idx] = { ...projects[idx], ...update };
    writeProjects(projects);
    return true;
  }
  return false;
}

function addRoleToProject(projectId, newRoleObj) {
  const projects = readProjects();
  const idx = projects.findIndex(p => p.id === projectId);
  if (idx !== -1) {
    if (!projects[idx].roles) projects[idx].roles = [];
    projects[idx].roles.push(newRoleObj);
    writeProjects(projects);
    return true;
  }
  return false;
}

module.exports = {
  getAllProjects,
  getProjectById,
  addProject,
  updateProject,
  addRoleToProject,
};
