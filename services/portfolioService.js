const path = require('path');
const portfolio = require(path.resolve(__dirname, '../data/portfolio_new.json'));

class PortfolioService {
    async getAllProjects() {
        // Assuming the JSON is an array, return it sorted by year
        return portfolio.sort((a, b) => b.year - a.year);
    }
}

module.exports = new PortfolioService();