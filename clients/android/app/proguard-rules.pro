# BouncyCastle 低层 crypto 类通过直接引用调用，保留即可。
-keep class org.bouncycastle.** { *; }
-dontwarn org.bouncycastle.**
