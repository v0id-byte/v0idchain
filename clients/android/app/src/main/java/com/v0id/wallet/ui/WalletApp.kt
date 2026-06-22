package com.v0id.wallet.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.AccountBalanceWallet
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Create
import androidx.compose.material.icons.outlined.Explore
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.MailOutline
import androidx.compose.material.icons.outlined.Redeem
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Storefront
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.fragment.app.FragmentActivity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.v0id.wallet.MessageView
import com.v0id.wallet.Newcomer
import com.v0id.wallet.SearchResult
import com.v0id.wallet.WalletUi
import com.v0id.wallet.WalletViewModel
import com.v0id.wallet.core.*
import com.v0id.wallet.net.WsClient
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// ───────────────────────── 工具 ─────────────────────────

private val timeFmt = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US)
private fun fmtTime(ms: Long): String = timeFmt.format(Date(ms))
private fun shortAddr(a: String): String = if (a.length > 16) "${a.take(8)}…${a.takeLast(6)}" else a

@Composable
private fun connLabel(status: WsClient.Status, height: Long): Pair<String, androidx.compose.ui.graphics.Color> {
    val s = LocalStatus.current
    return when (status) {
        WsClient.Status.CONNECTED -> (if (height >= 0) "已连接 · #$height" else "已连接") to s.online
        WsClient.Status.CONNECTING -> "连接中" to s.pending
        WsClient.Status.DISCONNECTED -> "未连接" to MaterialTheme.colorScheme.onSurfaceVariant
    }
}

// ───────────────────────── 根 ─────────────────────────

private data class TabSpec(val title: String, val icon: ImageVector)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WalletApp(vm: WalletViewModel) {
    val ui by vm.ui.collectAsState()
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(Unit) { vm.events.collect { snackbar.showSnackbar(it) } }

    if (!ui.ready) {
        Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }
    if (!ui.hasWallet) {
        OnboardingScreen(vm, snackbar)
        return
    }

    val tabs = listOf(
        TabSpec("钱包", Icons.Outlined.AccountBalanceWallet),
        TabSpec("转账", Icons.AutoMirrored.Outlined.Send),
        TabSpec("消息", Icons.Outlined.MailOutline),
        TabSpec("集市", Icons.Outlined.Storefront),
        TabSpec("红包", Icons.Outlined.Redeem),
        TabSpec("逛链", Icons.Outlined.Explore),
        TabSpec("设置", Icons.Outlined.Settings),
    )
    var tab by rememberSaveable { mutableStateOf(0) }
    var showCompose by rememberSaveable { mutableStateOf(false) }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = { Text(tabs[tab].title, fontWeight = FontWeight.SemiBold) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                actions = {
                    val (label, color) = connLabel(ui.connection, ui.height)
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(end = 4.dp)) {
                        Box(Modifier.size(8.dp).clip(CircleShape).background(color))
                        Spacer(Modifier.width(6.dp))
                        Text(label, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    when (tab) {
                        0 -> IconButton(onClick = { vm.refresh() }) { Icon(Icons.Outlined.Refresh, "刷新") }
                        2 -> IconButton(onClick = { showCompose = true }) { Icon(Icons.Outlined.Create, "写消息") }
                    }
                },
            )
        },
        bottomBar = {
            NavigationBar {
                tabs.forEachIndexed { i, t ->
                    NavigationBarItem(
                        selected = tab == i,
                        onClick = { tab = i },
                        icon = { Icon(t.icon, contentDescription = t.title) },
                        label = { Text(t.title, fontSize = 11.sp) },
                    )
                }
            }
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { pad ->
        Box(Modifier.padding(pad)) {
            when (tab) {
                0 -> WalletScreen(vm, ui)
                1 -> SendScreen(vm, ui)
                2 -> MessagesScreen(ui)
                3 -> MarketScreen(vm, ui)
                4 -> RedPacketScreen(vm, ui)
                5 -> ExploreScreen(vm, ui)
                else -> SettingsScreen(vm, ui)
            }
        }
    }

    if (showCompose) {
        ComposeSheet(vm, ui, onDismiss = { showCompose = false })
    }
}

// ───────────────────────── 通用组件（仿 iOS 分组 Form）─────────────────────────

@Composable
private fun FormSection(
    header: String? = null,
    footer: String? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(Modifier.fillMaxWidth()) {
        if (header != null) {
            Text(
                header,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 13.sp,
                modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 6.dp),
            )
        }
        Surface(
            color = MaterialTheme.colorScheme.surfaceVariant,
            shape = RoundedCornerShape(14.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(content = content)
        }
        if (footer != null) {
            Text(
                footer,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 12.sp,
                lineHeight = 16.sp,
                modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 6.dp),
            )
        }
    }
}

@Composable
private fun RowDivider() {
    HorizontalDivider(
        Modifier.padding(start = 16.dp),
        color = MaterialTheme.colorScheme.outlineVariant,
    )
}

/** 一行：label 左（次级）+ value 右（等宽）。 */
@Composable
private fun KeyValue(label: String, value: String, valueColor: androidx.compose.ui.graphics.Color? = null) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 13.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 15.sp)
        Spacer(Modifier.width(12.dp))
        Text(
            value,
            color = valueColor ?: MaterialTheme.colorScheme.onSurface,
            fontSize = 15.sp,
            fontFamily = FontFamily.Monospace,
            textAlign = TextAlign.End,
        )
    }
}

/** 可复制行：caption label + 等宽值 + 复制按钮。 */
@Composable
private fun CopyCell(label: String, value: String) {
    val clip = LocalClipboardManager.current
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp)
        Spacer(Modifier.height(4.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                value,
                modifier = Modifier.weight(1f),
                color = MaterialTheme.colorScheme.onSurface,
                fontSize = 13.sp,
                fontFamily = FontFamily.Monospace,
            )
            IconButton(onClick = { clip.setText(AnnotatedString(value)) }, modifier = Modifier.size(28.dp)) {
                Icon(
                    Icons.Outlined.ContentCopy, "复制",
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }
}

/** label 左 + 右侧数字输入（仿 LabeledContent）。 */
@Composable
private fun NumberRow(label: String, value: String, onChange: (String) -> Unit, placeholder: String) {
    val c = MaterialTheme.colorScheme
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = c.onSurfaceVariant, fontSize = 15.sp, modifier = Modifier.weight(1f))
        BasicTextField(
            value = value,
            onValueChange = onChange,
            singleLine = true,
            textStyle = TextStyle(color = c.onSurface, fontSize = 15.sp, textAlign = TextAlign.End, fontFamily = FontFamily.Monospace),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            cursorBrush = SolidColor(c.primary),
            modifier = Modifier.width(120.dp),
            decorationBox = { inner ->
                if (value.isEmpty()) {
                    Text(placeholder, color = c.onSurfaceVariant.copy(alpha = 0.5f), fontSize = 15.sp,
                        textAlign = TextAlign.End, fontFamily = FontFamily.Monospace, modifier = Modifier.fillMaxWidth())
                }
                inner()
            },
        )
    }
}

/** 整宽多行输入（地址 / 备注 / 正文 / 私钥）。 */
@Composable
private fun BlockField(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    mono: Boolean = false,
    minLines: Int = 1,
) {
    val c = MaterialTheme.colorScheme
    Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp)) {
        if (value.isEmpty()) {
            Text(placeholder, color = c.onSurfaceVariant.copy(alpha = 0.5f), fontSize = 15.sp,
                fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default)
        }
        BasicTextField(
            value = value,
            onValueChange = onChange,
            textStyle = TextStyle(color = c.onSurface, fontSize = 15.sp,
                fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default),
            cursorBrush = SolidColor(c.primary),
            minLines = minLines,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun PrimaryButton(text: String, icon: ImageVector?, enabled: Boolean, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth().height(50.dp),
    ) {
        if (icon != null) {
            Icon(icon, null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
        }
        Text(text, fontSize = 16.sp)
    }
}

// ───────────────────────── 引导 ─────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OnboardingScreen(vm: WalletViewModel, snackbar: SnackbarHostState) {
    var showImport by remember { mutableStateOf(false) }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        snackbarHost = { SnackbarHost(snackbar) },
    ) { pad ->
        Column(
            Modifier.fillMaxSize().padding(pad).padding(horizontal = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Icon(
                Icons.Outlined.AccountBalanceWallet, null,
                modifier = Modifier.size(56.dp),
                tint = MaterialTheme.colorScheme.primary,
            )
            Spacer(Modifier.height(16.dp))
            Text("v0idChain 轻钱包", fontSize = 26.sp, fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onBackground)
            Spacer(Modifier.height(8.dp))
            Text(
                "本地保管私钥 · 本地签名 · 连节点收发 $SYMBOL",
                color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 14.sp,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(36.dp))
            PrimaryButton("生成新钱包", null, true) { vm.createWallet() }
            Spacer(Modifier.height(12.dp))
            OutlinedButton(
                onClick = { showImport = true },
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth().height(50.dp),
            ) { Text("导入已有私钥", fontSize = 16.sp) }
            Spacer(Modifier.height(24.dp))
            Text(
                "私钥只存本机（Keystore 加密），绝不上传。$SYMBOL 为教学玩具币、无真实价值。",
                color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp,
                textAlign = TextAlign.Center,
            )
        }
    }
    if (showImport) ImportSheet(vm, onDismiss = { showImport = false })
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ImportSheet(vm: WalletViewModel, onDismiss: () -> Unit) {
    var hex by remember { mutableStateOf("") }
    val valid = hex.trim().removePrefix("0x").let { it.length == 64 && it.all { c -> c.isDigit() || c in 'a'..'f' || c in 'A'..'F' } }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = MaterialTheme.colorScheme.surface) {
        Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("导入钱包", fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface)
            FormSection(header = "64 位十六进制私钥", footer = "私钥 = 32 字节种子的 hex。导入后会派生地址并连接节点。") {
                BlockField(hex, { hex = it }, "0102…1f20（64 hex 字符）", mono = true, minLines = 2)
            }
            PrimaryButton("导入", Icons.Outlined.Key, valid) { vm.importWallet(hex); onDismiss() }
        }
    }
}

// ───────────────────────── 钱包 ─────────────────────────

@Composable
private fun WalletScreen(vm: WalletViewModel, ui: WalletUi) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        // 余额卡
        Surface(
            color = MaterialTheme.colorScheme.surfaceVariant,
            shape = RoundedCornerShape(20.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(
                Modifier.fillMaxWidth().padding(vertical = 28.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("余额", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
                Spacer(Modifier.height(6.dp))
                Row(verticalAlignment = Alignment.Bottom) {
                    Text("${ui.balance}", fontSize = 46.sp, fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onSurface)
                    Spacer(Modifier.width(6.dp))
                    Text(SYMBOL, fontSize = 16.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(bottom = 7.dp))
                }
                if (ui.pendingCount > 0) {
                    Text("可用 ${ui.available} · ${ui.pendingCount} 笔待打包",
                        color = LocalStatus.current.pending, fontSize = 12.sp)
                }
            }
        }

        FormSection {
            CopyCell("我的地址（= 公钥，可公开）", ui.address)
            if (ui.myName != null) {
                RowDivider()
                KeyValue("我的昵称", "@${ui.myName}", MaterialTheme.colorScheme.primary)
            }
            RowDivider()
            KeyValue("下一笔 nonce", "${ui.nextNonce}")
            if (ui.pendingCount > 0) {
                RowDivider()
                KeyValue("待确认交易", "${ui.pendingCount}", LocalStatus.current.pending)
            }
        }

        ClaimNameSection(vm, ui)

        FormSection(header = "网络") {
            KeyValue("节点", ui.nodeUrl.removePrefix("ws://"))
            RowDivider()
            KeyValue("链高", if (ui.height < 0) "—" else "#${ui.height}")
            RowDivider()
            KeyValue("🔥 全网已烧毁", "${ui.burned} $SYMBOL")
            if (ui.connection != WsClient.Status.CONNECTED && ui.log.isNotBlank()) {
                RowDivider()
                KeyValue("状态", ui.log, MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

// ───────────────────────── 链上昵称 ─────────────────────────

@Composable
private fun ClaimNameSection(vm: WalletViewModel, ui: WalletUi) {
    var name by rememberSaveable { mutableStateOf("") }
    val connected = ui.connection == WsClient.Status.CONNECTED
    FormSection(
        header = "🪪 链上昵称",
        footer = "自转 1 $SYMBOL + 手续费 1，先到先得，全网唯一。昵称 1~20 位小写字母/数字/_/-。",
    ) {
        BlockField(name, { name = it.lowercase() }, "小写字母/数字/_/-（1~20 位）", mono = true)
        RowDivider()
        PrimaryButton("抢注", Icons.Outlined.Create, connected && name.isNotBlank()) {
            vm.claimName(name); name = ""
        }
    }
}

// ───────────────────────── 转账 ─────────────────────────

@Composable
private fun SendScreen(vm: WalletViewModel, ui: WalletUi) {
    var to by remember { mutableStateOf("") }
    var amount by remember { mutableStateOf("") }
    var fee by remember { mutableStateOf("1") }
    var memo by remember { mutableStateOf("") }
    val connected = ui.connection == WsClient.Status.CONNECTED

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        FormSection(header = "收款方") {
            BlockField(to, { to = it }, "0x + 64 位 hex 地址", mono = true, minLines = 2)
        }
        FormSection(header = "金额与手续费") {
            NumberRow("金额（$SYMBOL）", amount, { amount = it }, "0")
            RowDivider()
            NumberRow("手续费 / gas", fee, { fee = it }, "1")
        }
        FormSection(header = "备注（可空，≤128 码点）") {
            BlockField(memo, { memo = it }, "备注…", minLines = 1)
        }
        PrimaryButton("签名并广播", Icons.AutoMirrored.Outlined.Send, connected) {
            vm.sendTransfer(to, amount, fee, memo)
            to = ""; amount = ""; memo = ""; fee = "1"
        }
        Text(
            "可用余额 ${ui.available} $SYMBOL。交易在本机用 ed25519 签名后广播到节点，约一个区块后确认。" +
                if (!connected) " 当前未连接节点。" else "",
            color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp, lineHeight = 16.sp,
            modifier = Modifier.padding(horizontal = 4.dp),
        )
    }
}

// ───────────────────────── 消息 ─────────────────────────

@Composable
private fun MessagesScreen(ui: WalletUi) {
    var inbox by rememberSaveable { mutableStateOf(true) }
    val list = if (inbox) ui.inbox else ui.outbox

    Column(Modifier.fillMaxSize()) {
        SegmentRow(
            options = listOf("收件箱 ${ui.inbox.size}", "发件箱 ${ui.outbox.size}"),
            selected = if (inbox) 0 else 1,
            onSelect = { inbox = it == 0 },
            modifier = Modifier.padding(16.dp),
        )
        if (list.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Outlined.MailOutline, null, modifier = Modifier.size(40.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(10.dp))
                    Text(if (inbox) "还没有人给你发消息" else "你还没发过消息",
                        color = MaterialTheme.colorScheme.onSurface, fontSize = 15.sp)
                    Spacer(Modifier.height(4.dp))
                    Text("消息会在所连节点把交易打包进区块后出现。",
                        color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp)
                }
            }
        } else {
            LazyColumn(
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(list, key = { it.msg.txid }) { mv -> MessageCard(mv, inbox, ui) }
            }
        }
    }
}

@Composable
private fun MessageCard(mv: MessageView, inbox: Boolean, ui: WalletUi) {
    val m = mv.msg
    Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(14.dp)) {
        Column(Modifier.fillMaxWidth().padding(14.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        (if (inbox) "来自 " else "发给 ") + ui.display(if (inbox) m.from else m.to),
                        color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp,
                    )
                    if (mv.encrypted) {
                        Spacer(Modifier.width(6.dp))
                        Text("🔒", fontSize = 12.sp)
                    }
                }
                Text("🔥${m.burn} · #${m.height}", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp)
            }
            Spacer(Modifier.height(6.dp))
            if (mv.locked) {
                Text("（加密内容，无法解密）", color = MaterialTheme.colorScheme.onSurfaceVariant,
                    fontSize = 15.sp, fontStyle = androidx.compose.ui.text.font.FontStyle.Italic)
            } else {
                Text(mv.plaintext ?: m.text, color = MaterialTheme.colorScheme.onSurface, fontSize = 15.sp)
            }
            Spacer(Modifier.height(6.dp))
            Text(fmtTime(m.timestamp), color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ComposeSheet(vm: WalletViewModel, ui: WalletUi, onDismiss: () -> Unit) {
    var to by remember { mutableStateOf("") }
    var text by remember { mutableStateOf("") }
    var burn by remember { mutableStateOf("5") }
    var fee by remember { mutableStateOf("1") }
    var encrypt by remember { mutableStateOf(false) }
    val connected = ui.connection == WsClient.Status.CONNECTED
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = MaterialTheme.colorScheme.surface) {
        Column(
            Modifier.padding(horizontal = 16.dp).padding(bottom = 32.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("发链上消息", fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface)
            FormSection(header = "收件人地址") {
                BlockField(to, { to = it }, "0x + 64 位 hex", mono = true, minLines = 2)
            }
            FormSection(header = "正文（≤$PLAIN_TEXT_LIMIT 码点）") {
                BlockField(text, { text = it }, "写点什么…", minLines = 3)
            }
            FormSection(
                header = "加密",
                footer = "开启端到端加密后，密文上链，只有你和 TA（用各自私钥）能解开，其他人只看到乱码。",
            ) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("🔒 端到端加密（只有 TA 能解）", color = MaterialTheme.colorScheme.onSurface,
                        fontSize = 15.sp, modifier = Modifier.weight(1f))
                    Switch(checked = encrypt, onCheckedChange = { encrypt = it })
                }
            }
            FormSection(header = "烧币与手续费", footer = "链上消息 = amount 0 + 烧币 + 正文。烧掉的 $SYMBOL 进虚空永久不可花；另付手续费给矿工。需所连节点已支持消息。") {
                NumberRow("销毁 burn（进虚空）", burn, { burn = it }, "5")
                RowDivider()
                NumberRow("手续费 / gas", fee, { fee = it }, "1")
            }
            PrimaryButton(if (encrypt) "加密并烧币发送" else "烧币发送", Icons.AutoMirrored.Outlined.Send, connected) {
                vm.sendMessage(to, text, burn, fee, encrypt); onDismiss()
            }
        }
    }
}

// ───────────────────────── 逛链 ─────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ExploreScreen(vm: WalletViewModel, ui: WalletUi) {
    var query by remember { mutableStateOf("") }
    val result = remember(query, ui.chain) { vm.search(query) }

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            BlockSearchField(query) { query = it }
        }
        when (val r = result) {
            SearchResult.Empty -> {
                if (ui.newcomers.isNotEmpty()) item { NewcomersSection(ui.newcomers, ui) }
                item {
                    Text("最近区块", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp,
                        modifier = Modifier.padding(start = 4.dp, top = 4.dp))
                }
                items(ui.chain.takeLast(30).reversed(), key = { it.hash }) { b -> BlockCard(b) }
                if (ui.chain.isEmpty()) item {
                    Text("尚未同步到区块。", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 14.sp)
                }
            }
            SearchResult.NotFound -> item {
                Text("未找到匹配的地址 / txid / 区块号。", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 14.sp)
            }
            is SearchResult.BlockHit -> item { BlockCard(r.block, expanded = true) }
            is SearchResult.TxHit -> item {
                FormSection(header = "交易 @ #${r.height}") { TxRows(r.tx) }
            }
            is SearchResult.AddressHit -> {
                item {
                    FormSection(header = "地址") {
                        CopyCell("地址", r.address)
                        RowDivider()
                        KeyValue("余额", "${r.balance} $SYMBOL")
                        RowDivider()
                        KeyValue("nonce / 交易数", "${r.nonce} / ${r.txs.size}")
                    }
                }
                item { Text("历史（最新在前）", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp,
                    modifier = Modifier.padding(start = 4.dp, top = 4.dp)) }
                items(r.txs.take(40)) { (h, tx) -> AddressTxRow(h, tx, r.address, ui) }
            }
        }
    }
}

@Composable
private fun BlockSearchField(query: String, onChange: (String) -> Unit) {
    val c = MaterialTheme.colorScheme
    Surface(color = c.surfaceVariant, shape = RoundedCornerShape(12.dp)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.Explore, null, tint = c.onSurfaceVariant, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(10.dp))
            Box(Modifier.weight(1f)) {
                if (query.isEmpty()) Text("地址 / txid / 区块号", color = c.onSurfaceVariant.copy(alpha = 0.6f), fontSize = 15.sp)
                BasicTextField(
                    value = query, onValueChange = onChange, singleLine = true,
                    textStyle = TextStyle(color = c.onSurface, fontSize = 15.sp, fontFamily = FontFamily.Monospace),
                    cursorBrush = SolidColor(c.primary), modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

@Composable
private fun NewcomersSection(newcomers: List<Newcomer>, ui: WalletUi) {
    FormSection(header = "新成员（最近首次上链）") {
        newcomers.take(6).forEachIndexed { i, nc ->
            if (i > 0) RowDivider()
            KeyValue(ui.display(nc.address), "#${nc.height}")
        }
    }
}

@Composable
private fun BlockCard(b: Block, expanded: Boolean = false) {
    Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(14.dp)) {
        Column(Modifier.fillMaxWidth().padding(14.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("#${b.index}", color = MaterialTheme.colorScheme.onSurface, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                Text("${b.transactions.size} 笔 · 难度 ${b.difficulty}", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp)
            }
            Spacer(Modifier.height(4.dp))
            Text(b.hash, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp, fontFamily = FontFamily.Monospace, maxLines = 1)
            Text("矿工 ${shortAddr(b.miner)} · ${fmtTime(b.timestamp)}", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp)
            if (expanded) {
                Spacer(Modifier.height(10.dp))
                b.transactions.forEach { tx ->
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    Spacer(Modifier.height(8.dp))
                    TxRows(tx)
                    Spacer(Modifier.height(8.dp))
                }
            }
        }
    }
}

@Composable
private fun AddressTxRow(height: Long, tx: Transaction, focus: String, ui: WalletUi) {
    val out = tx.from == focus
    val kind = when {
        tx.isCoinbase() -> "coinbase"
        tx.isMessage() -> "消息：${tx.memo}"
        out -> "转出 → ${ui.display(tx.to)}"
        else -> "转入 ← ${ui.display(tx.from)}"
    }
    Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(12.dp)) {
        Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(kind, color = MaterialTheme.colorScheme.onSurface, fontSize = 14.sp, maxLines = 1)
                Text("#$height · ${tx.txid.take(12)}…", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
            }
            if (!tx.isMessage()) {
                Text("${tx.amount}", color = MaterialTheme.colorScheme.onSurface, fontSize = 14.sp, fontFamily = FontFamily.Monospace)
            }
        }
    }
}

@Composable
private fun TxRows(tx: Transaction) {
    val kind = when { tx.isCoinbase() -> "coinbase"; tx.isMessage() -> "消息"; else -> "转账" }
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text("$kind · ${tx.amount} $SYMBOL · fee ${tx.fee}${if ((tx.burn ?: 0) > 0) " · 🔥${tx.burn}" else ""}",
            color = MaterialTheme.colorScheme.onSurface, fontSize = 13.sp)
        Text("from ${shortAddr(tx.from)}", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
        Text("to   ${shortAddr(tx.to)}", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
        if (tx.memo.isNotEmpty()) Text("memo: ${tx.memo}", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp)
        Text("txid ${tx.txid.take(20)}…", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
    }
}

// ───────────────────────── 设置 ─────────────────────────

@Composable
private fun SettingsScreen(vm: WalletViewModel, ui: WalletUi) {
    var node by remember(ui.nodeUrl) { mutableStateOf(ui.nodeUrl) }
    var showKey by remember { mutableStateOf(false) }
    var confirmReset by remember { mutableStateOf(false) }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        FormSection(
            header = "节点",
            footer = "默认公网种子 $DEFAULT_SEED_WS。本地调试用模拟器本地（$EMULATOR_HOST_WS）或 ws://127.0.0.1:6001。",
        ) {
            BlockField(node, { node = it }, "ws://host:port", mono = true)
            RowDivider()
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AssistChip(onClick = { node = DEFAULT_SEED_WS }, label = { Text("公网种子") })
                AssistChip(onClick = { node = EMULATOR_HOST_WS }, label = { Text("模拟器本地") })
            }
            RowDivider()
            val (label, color) = connLabel(ui.connection, ui.height)
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 13.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("状态", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 15.sp, modifier = Modifier.weight(1f))
                Box(Modifier.size(8.dp).clip(CircleShape).background(color))
                Spacer(Modifier.width(6.dp))
                Text(label, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Button(onClick = { vm.setNodeUrl(node) }, shape = RoundedCornerShape(12.dp), modifier = Modifier.weight(1f)) { Text("连接此节点") }
            OutlinedButton(onClick = { vm.disconnect() }, shape = RoundedCornerShape(12.dp), modifier = Modifier.weight(1f)) { Text("断开") }
        }

        FormSection(header = "诊断", footer = "复现 CLIENT-PROTOCOL §9 金标准向量：PUB_HEX → PREIMAGE → TXID → SIGNATURE。") {
            Box(Modifier.padding(12.dp)) {
                OutlinedButton(onClick = { vm.runDiagnostics() }, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
                    Text("运行金标准向量自检（§9）")
                }
            }
            ui.selfTest?.let { r ->
                RowDivider()
                Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                    CheckRow("PUB_HEX", r.pub.second)
                    CheckRow("转账 PREIMAGE / TXID / SIGNATURE", r.transferPreimage.second && r.transferTxid.second && r.transferSig.second)
                    CheckRow("消息 PREIMAGE / TXID / SIGNATURE", r.messagePreimage.second && r.messageTxid.second && r.messageSig.second)
                    CheckRow("JSON 转义", r.escape.second)
                    Spacer(Modifier.height(4.dp))
                    Text(
                        if (r.allGreen) "全绿，与全网逐字节兼容" else "存在不匹配项",
                        color = if (r.allGreen) LocalStatus.current.online else MaterialTheme.colorScheme.error,
                        fontSize = 13.sp, fontWeight = FontWeight.Medium,
                    )
                }
            }
        }

        val context = LocalContext.current
        FormSection(header = "钱包", footer = "私钥存于本机 Keystore 加密存储。清除前请先备份私钥，否则资产无法找回。") {
            Box(Modifier.padding(12.dp)) {
                OutlinedButton(onClick = {
                    // 显示私钥前先验身份（强生物识别 / 设备凭据）；无 FragmentActivity 或无锁屏时优雅放行。
                    val activity = context as? FragmentActivity
                    if (activity != null) BiometricGate.authenticate(activity, "显示私钥前请验证身份") { ok -> if (ok) showKey = true }
                    else showKey = true
                }, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Outlined.Key, null, modifier = Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("显示 / 备份私钥")
                }
            }
            RowDivider()
            Box(Modifier.padding(12.dp)) {
                OutlinedButton(
                    onClick = { confirmReset = true }, shape = RoundedCornerShape(10.dp),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("退出并清除本机私钥") }
            }
        }

        FormSection(header = "关于") {
            KeyValue("客户端", "v0idChain 轻钱包")
            RowDivider(); KeyValue("代币", SYMBOL)
            RowDivider(); KeyValue("最低手续费", "$MIN_FEE")
            RowDivider(); KeyValue("默认烧币", "$MESSAGE_BURN")
        }
    }

    if (showKey) {
        AlertDialog(
            onDismissRequest = { showKey = false },
            title = { Text("私钥（64 hex）") },
            text = { Text(vm.privateKeyHex() ?: "读取失败", fontFamily = FontFamily.Monospace, fontSize = 13.sp) },
            confirmButton = {
                val context = LocalContext.current
                // 私钥用敏感复制：API33+ 标记 EXTRA_IS_SENSITIVE + 60s 后自动清空剪贴板。
                TextButton(onClick = { vm.privateKeyHex()?.let { copySensitiveToClipboard(context, "私钥", it) }; showKey = false }) { Text("复制") }
            },
            dismissButton = { TextButton(onClick = { showKey = false }) { Text("关闭") } },
        )
    }
    if (confirmReset) {
        AlertDialog(
            onDismissRequest = { confirmReset = false },
            title = { Text("确认清除？") },
            text = { Text("将从本机删除私钥并退出钱包。务必已备份私钥。") },
            confirmButton = {
                TextButton(
                    onClick = { confirmReset = false; vm.resetWallet() },
                    colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
                ) { Text("清除") }
            },
            dismissButton = { TextButton(onClick = { confirmReset = false }) { Text("取消") } },
        )
    }
}

@Composable
private fun CheckRow(label: String, ok: Boolean) {
    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(if (ok) LocalStatus.current.online else MaterialTheme.colorScheme.error))
        Spacer(Modifier.width(10.dp))
        Text(label, color = MaterialTheme.colorScheme.onSurface, fontSize = 13.sp)
    }
}

// ───────────────────────── 集市 ─────────────────────────

@Composable
private fun MarketScreen(vm: WalletViewModel, ui: WalletUi) {
    var showSell by rememberSaveable { mutableStateOf(false) }
    val me = ui.address
    val connected = ui.connection == WsClient.Status.CONNECTED

    Column(Modifier.fillMaxSize()) {
        Box(Modifier.padding(16.dp)) {
            PrimaryButton("上架商品", Icons.Outlined.Create, connected) { showSell = true }
        }
        if (ui.listings.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Outlined.Storefront, null, modifier = Modifier.size(40.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(10.dp))
                    Text("集市空空如也", color = MaterialTheme.colorScheme.onSurface, fontSize = 15.sp)
                    Spacer(Modifier.height(4.dp))
                    Text("上架 = 自转 1 $SYMBOL + 备注 MKT|价格|标题，所连节点打包后出现。",
                        color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp, textAlign = TextAlign.Center)
                }
            }
        } else {
            LazyColumn(
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(ui.listings, key = { it.id }) { l -> ListingCard(l, me, connected, vm, ui) }
            }
        }
    }
    if (showSell) SellSheet(vm, onDismiss = { showSell = false })
}

@Composable
private fun ListingCard(l: Listing, me: String, connected: Boolean, vm: WalletViewModel, ui: WalletUi) {
    val mine = l.seller == me
    Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(14.dp)) {
        Column(Modifier.fillMaxWidth().padding(14.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text(l.title, color = MaterialTheme.colorScheme.onSurface, fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Text("${l.price} $SYMBOL", color = MaterialTheme.colorScheme.primary, fontSize = 15.sp, fontFamily = FontFamily.Monospace)
            }
            Spacer(Modifier.height(4.dp))
            Text("卖家 ${if (mine) "我" else ui.display(l.seller)}",
                color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp)
            Spacer(Modifier.height(10.dp))
            when {
                l.sold -> StatusPill("已售出" + (l.soldBy?.let { " · 买家 ${if (it == me) "我" else ui.display(it)}" } ?: ""), LocalStatus.current.online)
                l.delisted -> StatusPill("已撤单", MaterialTheme.colorScheme.onSurfaceVariant)
                mine -> OutlinedButton(
                    onClick = { vm.delistItem(l) }, enabled = connected,
                    shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth(),
                ) { Text("撤单") }
                else -> Button(
                    onClick = { vm.buyItem(l) }, enabled = connected,
                    shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth(),
                ) { Text("购买（付 ${l.price} $SYMBOL）") }
            }
        }
    }
}

@Composable
private fun StatusPill(text: String, color: androidx.compose.ui.graphics.Color) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(color))
        Spacer(Modifier.width(8.dp))
        Text(text, color = MaterialTheme.colorScheme.onSurface, fontSize = 13.sp)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SellSheet(vm: WalletViewModel, onDismiss: () -> Unit) {
    var price by remember { mutableStateOf("") }
    var title by remember { mutableStateOf("") }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = MaterialTheme.colorScheme.surface) {
        Column(
            Modifier.padding(horizontal = 16.dp).padding(bottom = 32.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("上架商品", fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface)
            FormSection(header = "标题（≤$MAX_TITLE 字）") {
                BlockField(title, { title = it }, "比如：复习笔记 / 二手书…", minLines = 1)
            }
            FormSection(
                header = "价格（$SYMBOL）",
                footer = "上架 = 自转 1 $SYMBOL + 手续费 $MIN_FEE，备注写 MKT|价格|标题。买家付款给你即成交。",
            ) {
                NumberRow("价格", price, { price = it }, "0")
            }
            PrimaryButton("上架", Icons.Outlined.Storefront, price.isNotBlank() && title.isNotBlank()) {
                vm.listItem(price, title); onDismiss()
            }
        }
    }
}

// ───────────────────────── 红包 ─────────────────────────

@Composable
private fun RedPacketScreen(vm: WalletViewModel, ui: WalletUi) {
    var showSend by rememberSaveable { mutableStateOf(false) }
    val me = ui.address
    val connected = ui.connection == WsClient.Status.CONNECTED

    Column(Modifier.fillMaxSize()) {
        Box(Modifier.padding(16.dp)) {
            PrimaryButton("发红包", Icons.Outlined.Redeem, connected) { showSend = true }
        }
        if (ui.redPackets.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Outlined.Redeem, null, modifier = Modifier.size(40.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(10.dp))
                    Text("还没有红包", color = MaterialTheme.colorScheme.onSurface, fontSize = 15.sp)
                    Spacer(Modifier.height(4.dp))
                    Text("发红包 = 转给托管地址 + 备注 RED|份数|模式。抢到的金额由所在区块敲定。",
                        color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp, textAlign = TextAlign.Center)
                }
            }
        } else {
            LazyColumn(
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(ui.redPackets, key = { it.id }) { rp -> RedPacketCard(rp, me, connected, ui.height, vm, ui) }
            }
        }
    }
    if (showSend) SendRedSheet(vm, onDismiss = { showSend = false })
}

@Composable
private fun RedPacketCard(rp: RedPacketView, me: String, connected: Boolean, height: Long, vm: WalletViewModel, ui: WalletUi) {
    val mine = rp.creator == me
    val iClaimed = rp.claims.firstOrNull { it.who == me }
    val canRefund = mine && !rp.done && height >= rp.createHeight + RED_EXPIRY
    val expireAt = rp.createHeight + RED_EXPIRY
    Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(14.dp)) {
        Column(Modifier.fillMaxWidth().padding(14.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("🧧 ${rp.total} $SYMBOL · ${rp.count} 份",
                    color = MaterialTheme.colorScheme.onSurface, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                Text(if (rp.mode == RedMode.RANDOM) "拼手气" else "均分",
                    color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp)
            }
            Spacer(Modifier.height(4.dp))
            Text("发起 ${if (mine) "我" else ui.display(rp.creator)} · #${rp.createHeight} · 剩 ${rp.remaining} / ${rp.remainingCount} 份",
                color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp)

            // 领取记录
            if (rp.claims.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                rp.claims.forEach { c ->
                    Text("· ${if (c.who == me) "我" else ui.display(c.who)} 抢到 ${c.amount} $SYMBOL（#${c.height}）",
                        color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp)
                }
            }

            Spacer(Modifier.height(10.dp))
            when {
                rp.refunded -> StatusPill("已退款", MaterialTheme.colorScheme.onSurfaceVariant)
                iClaimed != null -> StatusPill("已抢到 ${iClaimed.amount} $SYMBOL", LocalStatus.current.online)
                rp.done -> StatusPill("已抢完", MaterialTheme.colorScheme.onSurfaceVariant)
                mine -> {
                    if (canRefund) {
                        OutlinedButton(
                            onClick = { vm.refundRedPacket(rp) }, enabled = connected,
                            shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth(),
                        ) { Text("退回剩余 ${rp.remaining} $SYMBOL") }
                    } else {
                        StatusPill("自己发的，#$expireAt 后可退款", LocalStatus.current.pending)
                    }
                }
                else -> Button(
                    onClick = { vm.claimRedPacket(rp) }, enabled = connected,
                    shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth(),
                ) { Text("抢红包") }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SendRedSheet(vm: WalletViewModel, onDismiss: () -> Unit) {
    var total by remember { mutableStateOf("") }
    var count by remember { mutableStateOf("") }
    var random by remember { mutableStateOf(true) }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = MaterialTheme.colorScheme.surface) {
        Column(
            Modifier.padding(horizontal = 16.dp).padding(bottom = 32.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("发红包", fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface)
            FormSection(header = "金额与份数") {
                NumberRow("总额（$SYMBOL）", total, { total = it }, "0")
                RowDivider()
                NumberRow("份数（1~$MAX_RED_COUNT）", count, { count = it }, "0")
            }
            FormSection(
                header = "玩法",
                footer = "发红包 = 转给托管地址 + 备注 RED|份数|模式 + 手续费 $MIN_FEE。拼手气随机额由抢取所在区块敲定；超 $RED_EXPIRY 块没抢完可退款。",
            ) {
                Box(Modifier.padding(12.dp)) {
                    SegmentRow(
                        options = listOf("拼手气", "均分"),
                        selected = if (random) 0 else 1,
                        onSelect = { random = it == 0 },
                    )
                }
            }
            PrimaryButton("塞钱并发出", Icons.Outlined.Redeem, total.isNotBlank() && count.isNotBlank()) {
                vm.sendRedPacket(total, count, if (random) RedMode.RANDOM else RedMode.EQUAL); onDismiss()
            }
        }
    }
}

// ───────────────────────── 分段控件 ─────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SegmentRow(options: List<String>, selected: Int, onSelect: (Int) -> Unit, modifier: Modifier = Modifier) {
    SingleChoiceSegmentedButtonRow(modifier.fillMaxWidth()) {
        options.forEachIndexed { i, label ->
            SegmentedButton(
                selected = selected == i,
                onClick = { onSelect(i) },
                shape = SegmentedButtonDefaults.itemShape(index = i, count = options.size),
            ) { Text(label) }
        }
    }
}
