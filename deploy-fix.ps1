Write-Host "Deploying simplified video player fix..." -ForegroundColor Green
git add .
git commit -m "Fix Heroku deployment - remove API endpoint causing startup issues"
git push heroku main
Write-Host "Deployment complete!" -ForegroundColor Green
Write-Host "Checking app status..." -ForegroundColor Yellow
heroku ps --app guarded-inlet-25431
Write-Host "Getting recent logs..." -ForegroundColor Yellow
heroku logs --app guarded-inlet-25431 --num 50
