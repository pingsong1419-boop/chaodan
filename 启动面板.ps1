Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:worker = $null

$form = New-Object System.Windows.Forms.Form
$form.Text = '电商订单录入自动化'
$form.Size = New-Object System.Drawing.Size(780, 580)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false

$title = New-Object System.Windows.Forms.Label
$title.Text = '电商订单录入自动化 · 安全预览版'
$title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 16, [System.Drawing.FontStyle]::Bold)
$title.Location = New-Object System.Drawing.Point(24, 20)
$title.AutoSize = $true
$form.Controls.Add($title)

$tip = New-Object System.Windows.Forms.Label
$tip.Text = "使用方法：1. 启动浏览器  2. 登录并打开聚水潭与报价单  3. 在聚水潭选中订单  4. 点击开始识别"
$tip.Location = New-Object System.Drawing.Point(26, 62)
$tip.Size = New-Object System.Drawing.Size(720, 45)
$form.Controls.Add($tip)

$startButton = New-Object System.Windows.Forms.Button
$startButton.Text = '1. 启动浏览器'
$startButton.Location = New-Object System.Drawing.Point(28, 108)
$startButton.Size = New-Object System.Drawing.Size(155, 42)
$form.Controls.Add($startButton)

$runButton = New-Object System.Windows.Forms.Button
$runButton.Text = '2. 开始识别并填表'
$runButton.Location = New-Object System.Drawing.Point(198, 108)
$runButton.Size = New-Object System.Drawing.Size(180, 42)
$runButton.Enabled = $false
$form.Controls.Add($runButton)

$finishButton = New-Object System.Windows.Forms.Button
$finishButton.Text = '3. 核对完成并关闭'
$finishButton.Location = New-Object System.Drawing.Point(393, 108)
$finishButton.Size = New-Object System.Drawing.Size(180, 42)
$finishButton.Enabled = $false
$form.Controls.Add($finishButton)

$openFolderButton = New-Object System.Windows.Forms.Button
$openFolderButton.Text = '打开规则目录'
$openFolderButton.Location = New-Object System.Drawing.Point(588, 108)
$openFolderButton.Size = New-Object System.Drawing.Size(145, 42)
$form.Controls.Add($openFolderButton)

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Text = '状态：等待启动'
$statusLabel.ForeColor = [System.Drawing.Color]::DarkBlue
$statusLabel.Location = New-Object System.Drawing.Point(28, 165)
$statusLabel.Size = New-Object System.Drawing.Size(700, 28)
$form.Controls.Add($statusLabel)

$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Location = New-Object System.Drawing.Point(28, 198)
$logBox.Size = New-Object System.Drawing.Size(705, 300)
$logBox.Multiline = $true
$logBox.ReadOnly = $true
$logBox.ScrollBars = 'Vertical'
$logBox.BackColor = [System.Drawing.Color]::White
$logBox.Font = New-Object System.Drawing.Font('Consolas', 10)
$form.Controls.Add($logBox)

$safeLabel = New-Object System.Windows.Forms.Label
$safeLabel.Text = '安全模式：不会自动点击“保存”；未知物料、复杂窗型或字段缺失时会停止。'
$safeLabel.ForeColor = [System.Drawing.Color]::DarkGreen
$safeLabel.Location = New-Object System.Drawing.Point(28, 508)
$safeLabel.Size = New-Object System.Drawing.Size(705, 25)
$form.Controls.Add($safeLabel)

function Add-Log([string]$text) {
    if ([string]::IsNullOrWhiteSpace($text)) { return }
    $form.BeginInvoke([Action]{
        $logBox.AppendText($text + [Environment]::NewLine)
        $logBox.SelectionStart = $logBox.TextLength
        $logBox.ScrollToCaret()
    }) | Out-Null
}

$startButton.Add_Click({
    if ($script:worker -and -not $script:worker.HasExited) {
        [System.Windows.Forms.MessageBox]::Show('自动化已经在运行。', '提示') | Out-Null
        return
    }
    $nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $nodePath) {
        [System.Windows.Forms.MessageBox]::Show('没有找到 Node.js，请先安装 Node.js。', '缺少运行环境') | Out-Null
        return
    }
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $nodePath
    $info.Arguments = '"' + (Join-Path $projectDir 'src\index.js') + '"'
    $info.WorkingDirectory = $projectDir
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.RedirectStandardInput = $true
    $info.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $script:worker = New-Object System.Diagnostics.Process
    $script:worker.StartInfo = $info
    $script:worker.EnableRaisingEvents = $true
    $script:worker.add_OutputDataReceived({ param($sender, $event) if ($event.Data) { Add-Log $event.Data } })
    $script:worker.add_ErrorDataReceived({ param($sender, $event) if ($event.Data) { Add-Log ('错误：' + $event.Data) } })
    $script:worker.add_Exited({
        $form.BeginInvoke([Action]{
            $statusLabel.Text = '状态：任务已结束'
            $startButton.Enabled = $true
            $runButton.Enabled = $false
            $finishButton.Enabled = $false
        }) | Out-Null
    })
    try {
        $script:worker.Start() | Out-Null
        $script:worker.BeginOutputReadLine()
        $script:worker.BeginErrorReadLine()
        $statusLabel.Text = '状态：浏览器已启动，请登录并打开两个业务页面'
        $startButton.Enabled = $false
        $runButton.Enabled = $true
        Add-Log '已启动自动化浏览器。'
    } catch {
        Add-Log ('启动失败：' + $_.Exception.Message)
        $statusLabel.Text = '状态：启动失败'
    }
})

$runButton.Add_Click({
    if (-not $script:worker -or $script:worker.HasExited) {
        [System.Windows.Forms.MessageBox]::Show('请先启动浏览器。', '提示') | Out-Null
        return
    }
    $script:worker.StandardInput.WriteLine('')
    $script:worker.StandardInput.Flush()
    $statusLabel.Text = '状态：正在读取并解析当前选中订单'
    $runButton.Enabled = $false
    $finishButton.Enabled = $true
    Add-Log '已发送开始识别指令。'
})

$finishButton.Add_Click({
    if ($script:worker -and -not $script:worker.HasExited) {
        $script:worker.StandardInput.WriteLine('')
        $script:worker.StandardInput.Flush()
    }
    $statusLabel.Text = '状态：正在关闭自动化浏览器'
    $finishButton.Enabled = $false
})

$openFolderButton.Add_Click({
    Start-Process explorer.exe -ArgumentList $projectDir
})

$form.Add_FormClosing({
    if ($script:worker -and -not $script:worker.HasExited) {
        try { $script:worker.Kill($true) } catch {}
    }
})

[void]$form.ShowDialog()
