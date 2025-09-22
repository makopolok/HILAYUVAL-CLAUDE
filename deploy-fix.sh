#!/bin/bash
echo "📦 Deploying form validation fixes..."
git add views/audition.handlebars
git commit -m "Fix phone validation and improve form submission process"
git push heroku main
echo "✅ Deployment complete!"
echo "Checking app status..."
heroku ps --app guarded-inlet-25431
echo "🔗 Visit your app to test the changes"
