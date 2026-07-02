# AWS / EC2 运维

← [返回索引](README.md)

---

## AWS-1 EC2 Instance Connect SSH 密钥 60 s 过期

**症状**  
`send-ssh-public-key` 返回 `"Success": true`，但随后 SSH 返回
`Permission denied (publickey,gssapi-keyex,gssapi-with-mic)`。

**根因**  
EC2 Instance Connect 注入的临时公钥只有 **60 秒**有效期。  
并行循环（先注入所有实例再逐一 SSH）时，轮到第二个实例时密钥已失效。

**修法**  
注入和 SSH 必须原子化——封装成函数，每个实例各自独立注入后立即连接：

```bash
deploy() {
  local INST_ID=$1 IP=$2
  aws ec2-instance-connect send-ssh-public-key \
    --region us-east-2 --instance-id "$INST_ID" \
    --instance-os-user ec2-user \
    --ssh-public-key file://~/.ssh/id_ed25519.pub \
    --profile v0idops >/dev/null
  ssh -o StrictHostKeyChecking=no -i ~/.ssh/id_ed25519 ec2-user@"$IP" "..."
}

deploy i-001f90e1054826cbe 52.14.162.173 &
deploy i-09a5db3b03f031e57 18.219.146.255 &
deploy i-0fc8e190a86eb1fe5 18.118.227.210 &
wait
```

| 实例 | 用途 | IP |
|------|------|----|
| i-0b45dc36563a3dcb6 | box1 seed + HS | 3.133.151.251 |
| i-001f90e1054826cbe | r1 relay | 52.14.162.173 |
| i-09a5db3b03f031e57 | r2 relay | 18.219.146.255 |
| i-0fc8e190a86eb1fe5 | r3 relay | 18.118.227.210 |

⚠️ EC2 停启后 IP 会变，上表在变化时需更新。

---

## AWS-2 节点 OOM 随机重启（t2.micro 内存不足）

**症状**  
`v0id-seed.service` 随机重启或被杀死；`dmesg | grep -i oom` 可见 OOM Killer 日志。

**根因**  
社交链满节点内存占用 ~711 MB，t2.micro 仅 1 GB RAM，Linux OOM Killer 触发。

**修法**  
加 2 GB swap（`fallocate` 在某些 Amazon Linux 版本报 `EINVAL`，用 `dd` 代替）：

```bash
sudo dd if=/dev/zero of=/swapfile bs=128M count=16   # 2 GB
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile swap swap defaults 0 0' | sudo tee -a /etc/fstab
```

验证：`free -h` 应看到 2 G swap。

---

## AWS-3 Amazon Linux 2023 无 `nc` 命令

**症状**  
`nc -zv <host> <port>` 报 `bash: nc: command not found`。

**修法**  
用 curl 测 WebSocket 端口可达性：

```bash
curl -s -o /dev/null -w '%{http_code}' http://<host>:<port>
# 返回 426 = WebSocket 中继端口正常监听
# 返回 000 = 连不上
# 返回 403 = CF Bot Fight Mode 拦截（见 CF-3）
```

---

## AWS-4 git pull GitHub 超时（仅 mc box）

**症状**  
在 `mc.void1211.com`（非 AWS）上 `git pull` 或 `git fetch` 长时间卡住，
最终超时或报 `Connection timed out`。

**根因**  
mc 服务器网络路由对 GitHub 直连不稳定；需经本机 Clash 代理出站。
AWS EC2 直连 GitHub 正常，此问题仅限 mc box。

**修法（仅 mc box）**

```bash
git -c http.proxy=http://127.0.0.1:7890 fetch origin
git reset --hard origin/main
```

---

## AWS-5 `git pull` 报 "local changes" 被拒绝

**症状**  
`git pull` 输出 `Please commit your changes or stash them before you merge. Aborting`，
relay 节点停在旧代码。

**根因**  
直接在服务器上 patch 了文件但未 commit（常见于紧急热修），导致与上游 commit 冲突。

**修法**  
若上游已包含这些修改（已确认），直接 hard-reset：

```bash
git fetch origin
git reset --hard origin/main
corepack pnpm install --frozen-lockfile
sudo systemctl restart v0id-relay   # 或 v0id-seed
```

⚠️ 执行前先确认本地修改已被上游包含，否则会丢失 patch。  
可用 `git diff HEAD` 先查看本地改了什么。
