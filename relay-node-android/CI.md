# Android relay CI

```bash
# One-time on a dev machine with Gradle installed:
cd relay-node-android
gradle wrapper --gradle-version 8.7
./gradlew assembleDebug test lint
```

CI job (see `.github/workflows/ci.yml`) runs the same after wrapper jar is committed.
