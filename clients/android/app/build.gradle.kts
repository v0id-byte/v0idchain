plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.v0id.wallet"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.v0id.wallet"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    // —— 共识关键：RFC8032 ed25519（纯 Java，低层 crypto API，不注册 JCE Provider 避免与系统 BC 冲突）
    // 1.81：跟进最新稳定线做版本卫生（1.78.1 已含 CVE-2024-30171 修复、且本项目只用底层 ed25519/x25519/
    // chacha 原语、不触达 ASN.1/TLS 路径——属常规升级而非安全必需）。
    implementation("org.bouncycastle:bcprov-jdk18on:1.81")
    // WebSocket
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // 私钥加密存储（主密钥在 Android Keystore，落地用 AES-256-GCM 加密）
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    // 生物识别门限（显示/备份私钥前验身份）。BiometricPrompt 需要 FragmentActivity（见 MainActivity）。
    implementation("androidx.biometric:biometric:1.1.0")

    debugImplementation("androidx.compose.ui:ui-tooling")

    // 金标准向量自检：纯 JVM 单测（无需模拟器），core 仅依赖 BouncyCastle + java.security
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.bouncycastle:bcprov-jdk18on:1.81")
}
