plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }

android {
    namespace="com.reach.relay"
    compileSdk=35
    defaultConfig { applicationId="com.reach.relay"; minSdk=26; targetSdk=35; versionCode=2; versionName="2.0.0" }
    buildFeatures { buildConfig=true }
    buildTypes {
        release {
            isMinifyEnabled=false
            buildConfigField("String","REACH_CITIZEN_URL","\"${project.findProperty("reachCitizenUrl") ?: "https://YOUR-REACH-CITIZEN-DOMAIN/"}\"")
        }
        debug {
            buildConfigField("String","REACH_CITIZEN_URL","\"${project.findProperty("reachCitizenUrl") ?: "https://YOUR-REACH-CITIZEN-DOMAIN/"}\"")
        }
    }
}

dependencies { implementation("androidx.core:core-ktx:1.15.0"); implementation("androidx.appcompat:appcompat:1.7.0") }
