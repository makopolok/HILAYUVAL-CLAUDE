require('dotenv').config();
const express = require('express');
const { engine } = require('express-handlebars');
const errorHandler = require('./middleware/errorHandler');
const portfolioRoutes = require('./routes/portfolio');

const app = express();
const PORT = process.env.PORT || 3000;

// Handlebars setup
app.engine('handlebars', engine());
app.set('view engine', 'handlebars');
app.set('views', './views');

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Routes
app.use('/', portfolioRoutes);

// Error handling
app.use((req, res) => {
    res.status(404).render('error/404');
});


// Add at the end of middleware chain, before app.listen
app.use(errorHandler);

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

module.exports = app;