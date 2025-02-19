const path = require('path');
const portfolio = require(path.resolve(__dirname, '../data/portfolio.json'));

class PortfolioService {
    async getAllProjects() {
        return portfolio.projects.sort((a, b) => b.year - a.year);
    }
}

module.exports = new PortfolioService();