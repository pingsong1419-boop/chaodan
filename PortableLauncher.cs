using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

internal sealed class PortableLauncher : Form
{
    private readonly string root = AppDomain.CurrentDomain.BaseDirectory;
    private readonly Button startButton = new Button();
    private readonly Button stopButton = new Button();
    private readonly Button folderButton = new Button();
    private readonly Label statusLabel = new Label();
    private readonly TextBox logBox = new TextBox();
    private Process worker;

    public PortableLauncher()
    {
        Text = "订单抄单自动化";
        Size = new Size(860, 610);
        MinimumSize = new Size(760, 520);
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Microsoft YaHei UI", 10F);

        Label title = new Label();
        title.Text = "订单抄单自动化 · 安全录入";
        title.Font = new Font("Microsoft YaHei UI", 18F, FontStyle.Bold);
        title.Location = new Point(24, 20);
        title.AutoSize = true;

        Label tip = new Label();
        tip.Text = "点击启动后登录聚水潭与报价系统。勾选订单时，先核对确认卡片，再决定是否抄单。";
        tip.Location = new Point(27, 65);
        tip.Size = new Size(790, 30);

        startButton.Text = "启动程序";
        startButton.Location = new Point(28, 105);
        startButton.Size = new Size(155, 42);
        startButton.Click += StartWorker;

        stopButton.Text = "安全停止";
        stopButton.Location = new Point(198, 105);
        stopButton.Size = new Size(155, 42);
        stopButton.Enabled = false;
        stopButton.Click += StopWorker;

        folderButton.Text = "打开程序目录";
        folderButton.Location = new Point(368, 105);
        folderButton.Size = new Size(165, 42);
        folderButton.Click += delegate { Process.Start("explorer.exe", root); };

        statusLabel.Text = "状态：等待启动";
        statusLabel.ForeColor = Color.DarkBlue;
        statusLabel.Location = new Point(28, 163);
        statusLabel.Size = new Size(790, 28);

        logBox.Location = new Point(28, 198);
        logBox.Size = new Size(790, 305);
        logBox.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
        logBox.Multiline = true;
        logBox.ReadOnly = true;
        logBox.ScrollBars = ScrollBars.Vertical;
        logBox.BackColor = Color.White;
        logBox.Font = new Font("Microsoft YaHei UI", 9.5F);

        Label safety = new Label();
        safety.Text = "安全原则：权威目录必须唯一命中；信息不完整、电动、已抄或存在停单指令时一律拦截。";
        safety.ForeColor = Color.DarkGreen;
        safety.Location = new Point(28, 518);
        safety.Size = new Size(790, 30);
        safety.Anchor = AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;

        Controls.AddRange(new Control[] { title, tip, startButton, stopButton, folderButton, statusLabel, logBox, safety });
        FormClosing += OnClosing;
    }

    private void AddLog(string value)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        if (InvokeRequired) { BeginInvoke(new Action<string>(AddLog), value); return; }
        value = Regex.Replace(value, "\\x1B\\[[0-?]*[ -/]*[@-~]", "");
        logBox.AppendText(value + Environment.NewLine);
        logBox.SelectionStart = logBox.TextLength;
        logBox.ScrollToCaret();
    }

    private string ValidatePackage()
    {
        string node = Path.Combine(root, "runtime", "node.exe");
        string script = Path.Combine(root, "src", "index.js");
        string catalog = Path.Combine(root, "data", "selection-catalog.index.json");
        if (!File.Exists(node)) return "缺少 runtime\\node.exe，压缩包可能没有完整解压。";
        if (!File.Exists(script)) return "缺少 src\\index.js，程序文件不完整。";
        if (!File.Exists(catalog)) return "缺少权威物料目录，程序文件不完整。";
        return null;
    }

    private void StartWorker(object sender, EventArgs e)
    {
        if (worker != null && !worker.HasExited) return;
        string problem = ValidatePackage();
        if (problem != null) { MessageBox.Show(problem, "无法启动", MessageBoxButtons.OK, MessageBoxIcon.Error); AddLog(problem); return; }

        ProcessStartInfo info = new ProcessStartInfo();
        info.FileName = Path.Combine(root, "runtime", "node.exe");
        info.Arguments = "\"" + Path.Combine(root, "src", "index.js") + "\"";
        info.WorkingDirectory = root;
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.RedirectStandardInput = true;
        info.StandardOutputEncoding = Encoding.UTF8;
        info.StandardErrorEncoding = Encoding.UTF8;
        info.EnvironmentVariables["NO_COLOR"] = "1";

        worker = new Process();
        worker.StartInfo = info;
        worker.EnableRaisingEvents = true;
        worker.OutputDataReceived += delegate(object s, DataReceivedEventArgs a) { if (a.Data != null) HandleLine(a.Data); };
        worker.ErrorDataReceived += delegate(object s, DataReceivedEventArgs a) { if (a.Data != null) AddLog("错误：" + a.Data); };
        worker.Exited += delegate {
            try { BeginInvoke(new Action(delegate {
                statusLabel.Text = "状态：程序已停止";
                statusLabel.ForeColor = Color.DarkRed;
                startButton.Enabled = true;
                stopButton.Enabled = false;
                AddLog("程序已停止。如非主动停止，请查看上方错误信息。");
            })); } catch { }
        };

        try
        {
            worker.Start();
            worker.BeginOutputReadLine();
            worker.BeginErrorReadLine();
            startButton.Enabled = false;
            stopButton.Enabled = true;
            statusLabel.Text = "状态：正在打开系统页面……";
            statusLabel.ForeColor = Color.DarkOrange;
            AddLog("正在启动，请稍候……");
        }
        catch (Exception ex)
        {
            startButton.Enabled = true;
            stopButton.Enabled = false;
            AddLog("启动失败：" + ex.Message);
            MessageBox.Show("启动失败：\r\n" + ex.Message, "启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void HandleLine(string line)
    {
        AddLog(line);
        if (line.Contains("AUTOMATION_READY") || line.Contains("READY_FOR_NEXT_ORDER"))
        {
            Action ready = delegate {
                statusLabel.Text = "状态：已就绪，可以在聚水潭勾选订单";
                statusLabel.ForeColor = Color.DarkGreen;
            };
            if (InvokeRequired) BeginInvoke(ready); else ready();
        }
    }

    private void StopWorker(object sender, EventArgs e)
    {
        StopWorkerSafely();
    }

    private void StopWorkerSafely()
    {
        try
        {
            if (worker != null && !worker.HasExited)
            {
                worker.StandardInput.WriteLine("close");
                worker.StandardInput.Flush();
                if (!worker.WaitForExit(3000)) worker.Kill();
            }
        }
        catch { try { if (worker != null && !worker.HasExited) worker.Kill(); } catch { } }
        statusLabel.Text = "状态：程序已停止";
        statusLabel.ForeColor = Color.DarkRed;
        startButton.Enabled = true;
        stopButton.Enabled = false;
    }

    private void OnClosing(object sender, FormClosingEventArgs e)
    {
        StopWorkerSafely();
    }

    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--check")
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            bool ok = File.Exists(Path.Combine(root, "runtime", "node.exe"))
                && File.Exists(Path.Combine(root, "src", "index.js"))
                && File.Exists(Path.Combine(root, "data", "selection-catalog.index.json"));
            Environment.Exit(ok ? 0 : 2);
        }
        bool first;
        using (Mutex mutex = new Mutex(true, @"Local\OrderAutomationPortableLauncher", out first))
        {
            if (!first) { MessageBox.Show("程序已经打开，请使用现有窗口。", "订单抄单自动化"); return; }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new PortableLauncher());
            GC.KeepAlive(mutex);
        }
    }
}
