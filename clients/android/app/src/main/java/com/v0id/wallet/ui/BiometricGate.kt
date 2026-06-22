package com.v0id.wallet.ui

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

/**
 * 生物识别门限：显示/备份私钥前要求验证身份（强生物识别，失败回退设备凭据 PIN/图案/密码）。
 *
 * 取舍（同 iOS/macOS 端）：
 * - 用 BIOMETRIC_STRONG or DEVICE_CREDENTIAL，没录入生物识别也能用设备 PIN/密码，避免锁死。
 * - 设备没有任何可用验证手段（未设锁屏）时优雅放行（onResult(true)），教学钱包不因此把用户挡在外面。
 * - 这是「操作层」门限，不改 EncryptedSharedPreferences 的 MasterKey setUserAuthenticationRequired
 *   （那会牵动每次（含启动期）读私钥、无锁屏即崩——留作上设备实测后的后续项，见审计 F05）。
 */
object BiometricGate {
    fun authenticate(activity: FragmentActivity, reason: String, onResult: (Boolean) -> Unit) {
        val authenticators =
            BiometricManager.Authenticators.BIOMETRIC_STRONG or
                BiometricManager.Authenticators.DEVICE_CREDENTIAL
        if (BiometricManager.from(activity).canAuthenticate(authenticators) !=
            BiometricManager.BIOMETRIC_SUCCESS
        ) {
            onResult(true) // 无可用验证手段（未设锁屏）→ 放行
            return
        }
        val prompt = BiometricPrompt(
            activity,
            ContextCompat.getMainExecutor(activity),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    onResult(true)
                }
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    onResult(false) // 用户取消 / 多次失败锁定 / 硬件错误
                }
                // onAuthenticationFailed：单次匹配失败，弹窗仍在，等用户重试——此处不回调。
            },
        )
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle("验证身份")
            .setSubtitle(reason)
            .setAllowedAuthenticators(authenticators) // 允许设备凭据时不能设 negativeButtonText
            .build()
        prompt.authenticate(info)
    }
}
