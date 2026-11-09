using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

internal sealed class AutomationPanel : Form
{
    private readonly Button launchButton = new Button();
    private readonly Button runButton = new Button();
    private readonly Button finishButton = new Button();
    private readonly Button folderButton = new Button();
    private readonly Label status = new Label();
    private readonly TextBox log = new TextBox();
    private Process worker;
    private readonly string projectDir;

    public AutomationPanel()
    {
        projectDir = AppDomain.CurrentDomain.BaseDirectory;
        Text = "Order Entry Automation";
        Size = new Size(820, 600);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        Font = new Font("Microsoft YaHei UI", 10F);

        var title = new Label {
            Text = "Order Entry Automation",
            Font = new Font("Microsoft YaHei UI", 16F, FontStyle.Bold),
            Location = new Point(25, 20), AutoSize = true
        };
        var tip = new Label {
            Text = "1. Launch browser  2. Login and open both pages  3. Select an order  4. Read and fill",
            Location = new Point(27, 63), Size = new Size(750, 35)
        };

        launchButton.Text = "1. Launch Browser";
        launchButton.Location = new Point(28, 105);
        launchButton.Size = new Size(170, 44);
        launchButton.Click += Launch;

        runButton.Text = "2. Read and Fill";
        runButton.Location = new Point(212, 105);
        runButton.Size = new Size(170, 44);
        runButton.Enabled = false;
        runButton.Click += RunOrder;

        finishButton.Text = "3. Finish and Close";
        finishButton.Location = new Point(396, 105);
        finishButton.Size = new Size(180, 44);
        finishButton.Enabled = false;
        finishButton.Click += Finish;

        folderButton.Text = "Open Rule Folder";
        folderButton.Location = new Point(590, 105);
        folderButton.Size = new Size(175, 44);
        folderButton.Click += delegate { Process.Start("explorer.exe", projectDir); };

        status.Text = "Status: waiting";
        status.ForeColor = Color.DarkBlue;
        status.Location = new Point(28, 164);
        status.Size = new Size(735, 28);

        log.Location = new Point(28, 198);
        log.Size = new Size(737, 305);
        log.Multiline = true;
        log.ReadOnly = true;
        log.ScrollBars = ScrollBars.Vertical;
        log.BackColor = Color.White;
        log.Font = new Font("Consolas", 10F);

        var safe = new Label {
            Text = "遇到不能抄的订单会暂停；换一笔订单后可直接再次点击 Read and Fill。",
            ForeColor = Color.DarkGreen,
            Location = new Point(28, 515), Size = new Size(735, 25)
        };

        Controls.AddRange(new Control[] { title, tip, launchButton, runButton, finishButton, folderButton, status, log, safe });
        FormClosing += ClosingPanel;
    }

    private void AddLog(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        if (InvokeRequired) { BeginInvoke(new Action<string>(AddLog), text); return; }
        text = Regex.Replace(text, "\\x1B\\[[0-?]*[ -/]*[@-~]", "");
        log.AppendText(text + Environment.NewLine);
        log.SelectionStart = log.TextLength;
        log.ScrollToCaret();
    }

    private void HandleWorkerLine(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        if (text.Contains("AUTOMATION_READY"))
        {
            BeginInvoke(new Action(delegate {
                status.Text = "Status: ready; select an order";
                launchButton.Enabled = false;
                runButton.Enabled = true;
                finishButton.Enabled = true;
            }));
            return;
        }
        if (text.Contains("READY_FOR_NEXT_ORDER"))
        {
            BeginInvoke(new Action(delegate {
                status.Text = "Status: ready for next order";
                launchButton.Enabled = false;
                runButton.Enabled = true;
                finishButton.Enabled = true;
            }));
            AddLog("可以换一笔订单，再次点击 Read and Fill。");
            return;
        }
        AddLog(text);
    }

    private void Launch(object sender, EventArgs args)
    {
        if (worker != null && !worker.HasExited) return;
        var script = Path.Combine(projectDir, "src", "index.js");
        if (!File.Exists(script)) { MessageBox.Show("Missing src\\index.js", "Error"); return; }
        var info = new ProcessStartInfo {
            FileName = "node.exe",
            Arguments = "\"" + script + "\"",
            WorkingDirectory = projectDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        info.EnvironmentVariables["NO_COLOR"] = "1";
        worker = new Process { StartInfo = info, EnableRaisingEvents = true };
        worker.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) HandleWorkerLine(e.Data); };
        worker.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) AddLog("ERROR: " + e.Data); };
        worker.Exited += delegate {
            BeginInvoke(new Action(delegate {
                status.Text = "Status: task ended";
                launchButton.Enabled = true;
                runButton.Enabled = false;
                finishButton.Enabled = false;
            }));
        };
        try
        {
            worker.Start();
            worker.BeginOutputReadLine();
            worker.BeginErrorReadLine();
            status.Text = "Status: browser launched; login and open both pages";
            launchButton.Enabled = false;
            runButton.Enabled = true;
            AddLog("Browser worker started.");
        }
        catch (Exception ex)
        {
            AddLog("Launch failed: " + ex.Message);
            MessageBox.Show(ex.Message, "Launch failed");
        }
    }

    private void RunOrder(object sender, EventArgs args)
    {
        if (worker == null || worker.HasExited) { MessageBox.Show("Launch browser first."); return; }
        worker.StandardInput.WriteLine("RUN");
        worker.StandardInput.Flush();
        status.Text = "Status: reading selected order";
        runButton.Enabled = false;
        finishButton.Enabled = true;
        AddLog("Read order command sent.");
    }

    private void Finish(object sender, EventArgs args)
    {
        if (worker != null && !worker.HasExited) {
            worker.StandardInput.WriteLine("CLOSE");
            worker.StandardInput.Flush();
        }
        status.Text = "Status: closing browser";
        finishButton.Enabled = false;
    }

    private void ClosingPanel(object sender, FormClosingEventArgs args)
    {
        try { if (worker != null && !worker.HasExited) worker.Kill(); } catch { }
    }

    [STAThread]
    private static void Main()
    {
        bool isFirstInstance;
        using (var instanceLock = new Mutex(true, @"Local\OrderAutomationPanel-6D073949", out isFirstInstance))
        {
            if (!isFirstInstance)
            {
                MessageBox.Show("程序已经打开，请使用现有窗口。", "订单自动化");
                return;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new AutomationPanel());
            GC.KeepAlive(instanceLock);
        }
    }
}
