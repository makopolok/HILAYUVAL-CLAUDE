@echo off
echo Deploying to Heroku...
git add .
git commit -m "Deploy hilayuval.com application - %date% %time%"
git push heroku main
echo.
echo Checking app status...
heroku ps --app guarded-inlet-25431
echo.
echo Recent logs:
heroku logs --app guarded-inlet-25431 --tail --num 20
pause
