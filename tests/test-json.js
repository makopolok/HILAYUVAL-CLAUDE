const fs = require('fs');
const path = require('path');

try {
    // Move up one directory level from tests to root
    const jsonPath = path.join(__dirname, '..', 'data', 'portfolio_new.json');
    console.log('Reading from:', jsonPath);

    // Check if file exists
    if (!fs.existsSync(jsonPath)) {
        throw new Error(`Portfolio file not found at: ${jsonPath}`);
    }

    const rawData = fs.readFileSync(jsonPath);
    const portfolio = JSON.parse(rawData);

    // Validate structure
    console.log('\nJSON Structure Check:');
    console.log('- Has projects array:', Array.isArray(portfolio.projects));
    console.log('- Number of projects:', portfolio.projects.length);

    // Test first project data
    const firstProject = portfolio.projects[0];
    console.log('\nFirst Project Check:');
    console.log('- Has ID:', !!firstProject.id);
    console.log('- Has title:', !!firstProject.title);
    console.log('- Has Hebrew title:', !!firstProject.titleHebrew);
    console.log('- Has poster URLs:', Array.isArray(firstProject.posterUrls));

} catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
}