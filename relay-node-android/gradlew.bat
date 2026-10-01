@echo off
set APP_HOME=%~dp0
if not exist "%APP_HOME%gradle\wrapper\gradle-wrapper.jar" (
  echo gradle-wrapper.jar missing. Run: gradle wrapper --gradle-version 8.7
  exit /b 1
)
java -jar "%APP_HOME%gradle\wrapper\gradle-wrapper.jar" %*
