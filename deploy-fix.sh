#!/bin/bash
echo "Deploying simplified video player fix..."
git add .
git commit -m "Fix Heroku deployment - remove API endpoint causing startup issues"
git push heroku main
echo "Deployment complete!"
echo "Checking app status..."
heroku ps --app guarded-inlet-25431
