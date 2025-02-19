const errorHandler = (err, req, res, next) => {
    // Log error for debugging
    console.error('Error:', err.message);
    console.error('Stack:', err.stack);

    // Set locals, only providing error in development
    res.locals.message = err.message;
    res.locals.error = process.env.NODE_ENV === 'development' ? err : {};

    // Render the error page
    const statusCode = err.status || 500;
    res.status(statusCode);
    res.render('error/500', {
        title: 'Server Error',
        error: err
    });
};

module.exports = errorHandler;