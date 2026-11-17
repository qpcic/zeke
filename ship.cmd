@echo off
setlocal
rem Commit everything, push, open a PR into main and merge it (normal merge commit).
rem The merge commit gets your note as its title + a bullet list of every commit going out,
rem which is what Zeke posts to the updates channel.
rem Usage:  ship "what changed"

set "NOTE=%~1"
for /f "delims=" %%b in ('git branch --show-current') do set "BRANCH=%%b"
if /i "%BRANCH%"=="main" (
  echo You are on main. Switch to dev first: git switch dev
  exit /b 1
)

rem 1. commit whatever changed (needs a note)
git add .
git diff --cached --quiet
if errorlevel 1 (
  if "%NOTE%"=="" (
    echo There are changes to commit. Usage: ship "what changed"
    exit /b 1
  )
  git commit -m "%NOTE%" || exit /b 1
)

rem 2. push the branch
git push origin %BRANCH% || exit /b 1

rem 3. list every commit not on main yet, oldest first (merge commits skipped)
git fetch origin main --quiet
set "TITLE=%NOTE%"
if "%TITLE%"=="" set "TITLE=Zeke update"
set "NOTES=%TEMP%\zeke-ship-notes.txt"
git log origin/main..HEAD --no-merges --reverse --pretty=format:"- %%s" > "%NOTES%"
for %%A in ("%NOTES%") do if %%~zA==0 (
  echo Nothing to ship: %BRANCH% has no commits that are not on main.
  exit /b 1
)
echo.
echo Shipping "%TITLE%":
type "%NOTES%"
echo.

rem 4. open the PR and merge it
gh pr create --base main --title "%TITLE%" --body-file "%NOTES%"
if errorlevel 1 echo PR not created ^(maybe it already exists^), trying to merge anyway...

rem give GitHub a moment to register the PR
powershell -NoProfile -Command "Start-Sleep -Milliseconds 3000"

gh pr merge --merge --subject "%TITLE%" --body-file "%NOTES%"
