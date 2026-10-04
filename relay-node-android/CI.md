# Android relay CI

The Gradle wrapper is committed (`gradle/wrapper/gradle-wrapper.jar`), so the
build runs from a clean checkout with only a JDK and the Android SDK:

```bash
cd relay-node-android
echo "sdk.dir=$ANDROID_HOME" > local.properties   # local only, git-ignored
./gradlew assembleDebug lint testDebugUnitTest
```

`testDebugUnitTest` runs the JVM unit tests (Robolectric): BLE fragment reassembly
(`BleTransferTest`), the durable queue (`RelayQueueDbTest`), the canonical/envelope contract
(`RelayProtocolTest`) and the gateway uploader (`RelayGatewayUploaderTest`, including a real
loopback HTTP round trip).

CI job (see `.github/workflows/ci.yml`) runs the same on JDK 17 once the
wrapper jar is present, and uploads the debug APK as the `reach-relay-node-debug-apk`
artifact. Run the workflow manually (`workflow_dispatch`) with `reach_citizen_url` set to
your deployed PWA URL to get an installable APK without a local SDK. A plain push builds
with the placeholder URL, which opens a blank page — set the input for a usable build.

## Toolchain

| Component | Version |
|-----------|---------|
| Gradle    | 8.7 (`gradle-wrapper.properties`) |
| AGP       | 8.6.1 |
| Kotlin    | 2.0.21 |
| compileSdk / targetSdk | 35 |
| minSdk    | 26 |
| JVM target | 17 (Java and Kotlin must match) |

To regenerate the wrapper on a machine with Gradle installed:

```bash
gradle wrapper --gradle-version 8.7
```
