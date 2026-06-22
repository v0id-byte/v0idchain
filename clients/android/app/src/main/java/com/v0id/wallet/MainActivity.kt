package com.v0id.wallet

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.core.view.WindowCompat
import androidx.fragment.app.FragmentActivity
import com.v0id.wallet.ui.V0idTheme
import com.v0id.wallet.ui.WalletApp

// FragmentActivity（而非 ComponentActivity）：androidx.biometric 的 BiometricPrompt 要求宿主为
// FragmentActivity。FragmentActivity 继承自 ComponentActivity，viewModels()/setContent/edgeToEdge 照常可用。
class MainActivity : FragmentActivity() {

    private val viewModel: WalletViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContent {
            V0idTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    WalletApp(viewModel)
                }
            }
        }
    }
}
