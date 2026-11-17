@echo off
rem Open a PR from the current branch (title/body from the commits) and merge it (normal merge commit, keeps main and dev in sync).
rem Usage: ship

gh pr create --fill
if errorlevel 1 echo PR not created ^(maybe it already exists^), trying to merge anyway...

rem give GitHub a moment to register the PR
powershell -NoProfile -Command "Start-Sleep -Milliseconds 3000"

gh pr merge --merge
