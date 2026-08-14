using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;

[assembly: AssemblyTitle("ACGO 爬虫一键启动器")]
[assembly: AssemblyDescription("ACGO 作业与竞赛代码证据包图形启动器")]
[assembly: AssemblyCompany("ACGO Crawler")]
[assembly: AssemblyProduct("ACGO Crawler Launcher")]
[assembly: AssemblyVersion("2.0.0.0")]
[assembly: AssemblyFileVersion("2.0.0.0")]

namespace AcgoCrawlerLauncher
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            string appRoot = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
            if (args.Any(arg => string.Equals(arg, "--self-test", StringComparison.OrdinalIgnoreCase)))
            {
                return RunSelfTest(appRoot);
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm(appRoot));
            return 0;
        }

        private static int RunSelfTest(string appRoot)
        {
            string errorFile = Path.Combine(appRoot, "launcher-self-test-error.txt");
            try
            {
                if (File.Exists(errorFile)) File.Delete(errorFile);
                ProjectLayout.Validate(appRoot);
                string node = RuntimeManager.ResolveNode(appRoot, delegate(string ignored) { });
                RuntimeManager.ValidateNodeVersion(node);
                return 0;
            }
            catch (Exception error)
            {
                File.WriteAllText(errorFile, error.ToString(), new UTF8Encoding(false));
                return 1;
            }
        }
    }

    internal sealed class MainForm : Form
    {
        private readonly string appRoot;
        private readonly RadioButton interactiveMode;
        private readonly RadioButton configMode;
        private readonly TextBox teamInput;
        private readonly CheckBox homeworkEnabled;
        private readonly TextBox homeworkId;
        private readonly CheckBox contestEnabled;
        private readonly TextBox contestId;
        private readonly TextBox sessionName;
        private readonly TextBox promptPath;
        private readonly TextBox configPath;
        private readonly Button browsePromptButton;
        private readonly Button browseConfigButton;
        private readonly Button openConfigButton;
        private readonly Button startButton;
        private readonly Button stopButton;
        private readonly Button openResultButton;
        private readonly RichTextBox logBox;
        private readonly Label statusLabel;
        private readonly ProgressBar progressBar;
        private Process crawlerProcess;
        private string generatedConfigPath;
        private string resultZipPath;
        private DateTime runStartedAt;
        private bool allowClose;

        public MainForm(string appRoot)
        {
            this.appRoot = appRoot;
            Version assemblyVersion = Assembly.GetExecutingAssembly().GetName().Version;
            string displayVersion = assemblyVersion.Major + "." + assemblyVersion.Minor;
            Text = "ACGO 爬虫 " + displayVersion + " 一键启动器";
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(900, 700);
            ClientSize = new Size(960, 730);
            AutoScaleMode = AutoScaleMode.Dpi;
            Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
            BackColor = Color.FromArgb(246, 248, 251);

            Label title = new Label();
            title.Text = "ACGO 作业 / 竞赛证据包 " + displayVersion;
            title.Font = new Font(Font.FontFamily, 18F, FontStyle.Bold);
            title.ForeColor = Color.FromArgb(25, 45, 75);
            title.Location = new Point(24, 18);
            title.AutoSize = true;
            Controls.Add(title);

            Label subtitle = new Label();
            subtitle.Text = "填写任务后点击开始；程序会准备 Node 运行时、弹出 Edge，并生成可直接发送给 AI 的 ZIP。";
            subtitle.ForeColor = Color.FromArgb(75, 86, 104);
            subtitle.Location = new Point(28, 58);
            subtitle.AutoSize = true;
            Controls.Add(subtitle);

            GroupBox setupGroup = new GroupBox();
            setupGroup.Text = "任务配置";
            setupGroup.Location = new Point(24, 88);
            setupGroup.Size = new Size(912, 270);
            setupGroup.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            setupGroup.BackColor = Color.White;
            Controls.Add(setupGroup);

            interactiveMode = new RadioButton();
            interactiveMode.Text = "界面填写（推荐）";
            interactiveMode.Checked = true;
            interactiveMode.Location = new Point(18, 28);
            interactiveMode.AutoSize = true;
            interactiveMode.CheckedChanged += delegate { UpdateMode(); };
            setupGroup.Controls.Add(interactiveMode);

            configMode = new RadioButton();
            configMode.Text = "使用现有 config.json";
            configMode.Location = new Point(170, 28);
            configMode.AutoSize = true;
            configMode.CheckedChanged += delegate { UpdateMode(); };
            setupGroup.Controls.Add(configMode);

            AddLabel(setupGroup, "团队 ID / 团队页面 URL", 18, 66);
            teamInput = AddTextBox(setupGroup, 185, 62, 692);
            teamInput.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;

            homeworkEnabled = new CheckBox();
            homeworkEnabled.Text = "作业 ID";
            homeworkEnabled.Checked = true;
            homeworkEnabled.Location = new Point(18, 104);
            homeworkEnabled.AutoSize = true;
            homeworkEnabled.CheckedChanged += delegate { homeworkId.Enabled = interactiveMode.Checked && homeworkEnabled.Checked; };
            setupGroup.Controls.Add(homeworkEnabled);
            homeworkId = AddTextBox(setupGroup, 185, 100, 250);

            contestEnabled = new CheckBox();
            contestEnabled.Text = "竞赛 ID";
            contestEnabled.Location = new Point(470, 104);
            contestEnabled.AutoSize = true;
            contestEnabled.CheckedChanged += delegate { contestId.Enabled = interactiveMode.Checked && contestEnabled.Checked; };
            setupGroup.Controls.Add(contestEnabled);
            contestId = AddTextBox(setupGroup, 570, 100, 307);
            contestId.Enabled = false;

            AddLabel(setupGroup, "证据包名称", 18, 142);
            sessionName = AddTextBox(setupGroup, 185, 138, 250);
            sessionName.Text = "ACGO-代码证据包";

            AddLabel(setupGroup, "AI 提示词（必需）", 470, 142);
            promptPath = AddTextBox(setupGroup, 610, 138, 221);
            browsePromptButton = AddBrowseButton(setupGroup, 838, 137, BrowsePrompt);

            AddLabel(setupGroup, "配置文件", 18, 181);
            configPath = AddTextBox(setupGroup, 185, 177, 646);
            configPath.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            browseConfigButton = AddBrowseButton(setupGroup, 838, 176, BrowseConfig);

            openConfigButton = new Button();
            openConfigButton.Text = "打开配置文件";
            openConfigButton.Location = new Point(185, 216);
            openConfigButton.Size = new Size(120, 32);
            openConfigButton.Click += delegate { OpenConfigFile(); };
            setupGroup.Controls.Add(openConfigButton);

            Label modeHint = new Label();
            modeHint.Text = "作业和竞赛至少选择一个；团队输入支持纯数字或 https://www.acgo.cn/team/数字。";
            modeHint.Location = new Point(320, 223);
            modeHint.AutoSize = true;
            modeHint.ForeColor = Color.FromArgb(85, 96, 114);
            setupGroup.Controls.Add(modeHint);

            startButton = new Button();
            startButton.Text = "开始全量任务";
            startButton.Font = new Font(Font.FontFamily, 10F, FontStyle.Bold);
            startButton.BackColor = Color.FromArgb(31, 111, 235);
            startButton.ForeColor = Color.White;
            startButton.FlatStyle = FlatStyle.Flat;
            startButton.FlatAppearance.BorderSize = 0;
            startButton.Location = new Point(24, 372);
            startButton.Size = new Size(150, 42);
            startButton.Click += async delegate { await StartRunAsync(); };
            Controls.Add(startButton);

            stopButton = new Button();
            stopButton.Text = "停止任务";
            stopButton.Location = new Point(186, 372);
            stopButton.Size = new Size(105, 42);
            stopButton.Enabled = false;
            stopButton.Click += delegate { StopRun(); };
            Controls.Add(stopButton);

            openResultButton = new Button();
            openResultButton.Text = "打开 ZIP 位置";
            openResultButton.Location = new Point(303, 372);
            openResultButton.Size = new Size(130, 42);
            openResultButton.Enabled = false;
            openResultButton.Click += delegate { OpenResult(); };
            Controls.Add(openResultButton);

            progressBar = new ProgressBar();
            progressBar.Location = new Point(452, 378);
            progressBar.Size = new Size(484, 18);
            progressBar.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            Controls.Add(progressBar);

            statusLabel = new Label();
            statusLabel.Text = "准备就绪";
            statusLabel.Location = new Point(452, 400);
            statusLabel.AutoSize = true;
            statusLabel.ForeColor = Color.FromArgb(69, 80, 96);
            Controls.Add(statusLabel);

            logBox = new RichTextBox();
            logBox.Location = new Point(24, 430);
            logBox.Size = new Size(912, 276);
            logBox.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
            logBox.ReadOnly = true;
            logBox.BackColor = Color.FromArgb(16, 24, 40);
            logBox.ForeColor = Color.FromArgb(226, 232, 240);
            logBox.Font = new Font("Consolas", 9F);
            logBox.BorderStyle = BorderStyle.None;
            Controls.Add(logBox);

            string defaultPrompt = Path.Combine(appRoot, "提示词.md");
            promptPath.Text = defaultPrompt;
            string defaultConfig = Path.Combine(appRoot, "config.json");
            configPath.Text = defaultConfig;

            FormClosing += HandleFormClosing;
            Shown += delegate
            {
                AppendLog("欢迎使用 ACGO 爬虫。界面不会读取或显示 config.json 中的敏感值。\r\n");
                AppendLog("首次运行时 Edge 会弹出；请按页面提示登录 ACGO，程序将继续执行。\r\n");
                UpdateMode();
            };
        }

        private static void AddLabel(Control parent, string text, int x, int y)
        {
            Label label = new Label();
            label.Text = text;
            label.Location = new Point(x, y);
            label.Size = new Size(165, 25);
            parent.Controls.Add(label);
        }

        private static TextBox AddTextBox(Control parent, int x, int y, int width)
        {
            TextBox box = new TextBox();
            box.Location = new Point(x, y);
            box.Size = new Size(width, 26);
            parent.Controls.Add(box);
            return box;
        }

        private static Button AddBrowseButton(Control parent, int x, int y, EventHandler handler)
        {
            Button button = new Button();
            button.Text = "浏览";
            button.Location = new Point(x, y);
            button.Size = new Size(58, 28);
            button.Click += handler;
            parent.Controls.Add(button);
            return button;
        }

        private void UpdateMode()
        {
            bool useInteractive = interactiveMode.Checked;
            teamInput.Enabled = useInteractive;
            homeworkEnabled.Enabled = useInteractive;
            homeworkId.Enabled = useInteractive && homeworkEnabled.Checked;
            contestEnabled.Enabled = useInteractive;
            contestId.Enabled = useInteractive && contestEnabled.Checked;
            sessionName.Enabled = useInteractive;
            promptPath.Enabled = useInteractive;
            browsePromptButton.Enabled = useInteractive;
            configPath.Enabled = !useInteractive;
            browseConfigButton.Enabled = !useInteractive;
            openConfigButton.Enabled = !useInteractive;
        }

        private void BrowsePrompt(object sender, EventArgs args)
        {
            using (OpenFileDialog dialog = new OpenFileDialog())
            {
                dialog.Title = "选择 AI 提示词";
                dialog.Filter = "Markdown 文件 (*.md)|*.md|所有文件 (*.*)|*.*";
                if (dialog.ShowDialog(this) == DialogResult.OK) promptPath.Text = dialog.FileName;
            }
        }

        private void BrowseConfig(object sender, EventArgs args)
        {
            using (OpenFileDialog dialog = new OpenFileDialog())
            {
                dialog.Title = "选择 config.json";
                dialog.Filter = "JSON 文件 (*.json)|*.json|所有文件 (*.*)|*.*";
                if (dialog.ShowDialog(this) == DialogResult.OK) configPath.Text = dialog.FileName;
            }
        }

        private void OpenConfigFile()
        {
            string filename = configPath.Text.Trim();
            if (!File.Exists(filename))
            {
                string defaultConfig = Path.GetFullPath(Path.Combine(appRoot, "config.json"));
                string exampleConfig = Path.Combine(appRoot, "config.example.json");
                if (string.Equals(Path.GetFullPath(filename), defaultConfig, StringComparison.OrdinalIgnoreCase) && File.Exists(exampleConfig))
                {
                    File.Copy(exampleConfig, defaultConfig, false);
                    filename = defaultConfig;
                    configPath.Text = defaultConfig;
                    AppendLog("[启动器] 已根据 config.example.json 创建 config.json，请编辑后保存。\r\n");
                }
                else
                {
                    MessageBox.Show(this, "配置文件不存在。请先选择或创建 config.json。", "找不到配置", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
            }
            Process.Start(new ProcessStartInfo(filename) { UseShellExecute = true });
        }

        private async Task StartRunAsync()
        {
            try
            {
                ProjectLayout.Validate(appRoot);
                string selectedConfig = PrepareConfig();
                SetRunning(true, "正在检查运行环境……");
                logBox.Clear();
                resultZipPath = null;
                runStartedAt = DateTime.Now;

                AppendLog("[启动器] 程序目录：" + appRoot + "\r\n");
                string node = await Task.Run(() => RuntimeManager.ResolveNode(appRoot, AppendLogThreadSafe));
                AppendLog("[启动器] Node：" + node + "\r\n");
                RuntimeManager.ValidateNodeVersion(node);

                string entry = Path.Combine(appRoot, "src", "index.mjs");
                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = node;
                info.Arguments = Quote(entry) + " --config " + Quote(selectedConfig);
                info.WorkingDirectory = appRoot;
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                info.RedirectStandardOutput = true;
                info.RedirectStandardError = true;
                info.StandardOutputEncoding = Encoding.UTF8;
                info.StandardErrorEncoding = Encoding.UTF8;
                info.EnvironmentVariables["NO_COLOR"] = "1";
                info.EnvironmentVariables["FORCE_COLOR"] = "0";

                AppendLog("[启动器] 正在启动全量任务。Edge 将自动弹出或连接；如未登录，请在 Edge 中完成登录。\r\n\r\n");
                int exitCode = await RunCrawlerProcessAsync(info);
                if (exitCode != 0)
                    throw new InvalidOperationException("爬虫退出码为 " + exitCode + "。请查看日志中的“导出失败”信息。");

                if (string.IsNullOrWhiteSpace(resultZipPath) || !File.Exists(resultZipPath))
                {
                    resultZipPath = FindLatestZip();
                }
                if (string.IsNullOrWhiteSpace(resultZipPath) || !File.Exists(resultZipPath))
                {
                    throw new FileNotFoundException("任务执行成功，但未找到最终 ZIP。请查看日志中的 ZIP 路径。");
                }

                AppendLog("\r\n[启动器] 完成：" + resultZipPath + "\r\n");
                SetRunning(false, "已完成，ZIP 可以直接发送给 AI");
                openResultButton.Enabled = true;
                MessageBox.Show(this, "证据包已经生成：\r\n\r\n" + resultZipPath, "任务完成", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception error)
            {
                AppendLog("\r\n[启动器] 失败：" + error.Message + "\r\n");
                SetRunning(false, "任务失败，请查看日志");
                MessageBox.Show(this, error.Message, "任务失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                crawlerProcess = null;
                CleanupTemporaryConfig();
            }
        }

        private async Task<int> RunCrawlerProcessAsync(ProcessStartInfo info)
        {
            crawlerProcess = new Process();
            crawlerProcess.StartInfo = info;
            crawlerProcess.EnableRaisingEvents = true;
            crawlerProcess.OutputDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
            {
                if (eventArgs.Data != null) HandleCrawlerLine(eventArgs.Data);
            };
            crawlerProcess.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
            {
                if (eventArgs.Data != null) HandleCrawlerLine(eventArgs.Data);
            };
            if (!crawlerProcess.Start()) throw new InvalidOperationException("无法启动 Node 进程。");
            crawlerProcess.BeginOutputReadLine();
            crawlerProcess.BeginErrorReadLine();
            statusLabel.Text = "任务运行中，请留意 Edge 登录页面和下方日志";
            await Task.Run(() => crawlerProcess.WaitForExit());
            crawlerProcess.WaitForExit();
            return crawlerProcess.ExitCode;
        }

        private string PrepareConfig()
        {
            if (configMode.Checked)
            {
                string existing = Path.GetFullPath(configPath.Text.Trim());
                if (!File.Exists(existing)) throw new FileNotFoundException("找不到配置文件：" + existing);
                return existing;
            }

            string rawTeam = teamInput.Text.Trim();
            Match teamMatch = Regex.Match(rawTeam, @"(?:^|/team/)(\d+)(?:[/?#].*)?$", RegexOptions.IgnoreCase);
            if (!teamMatch.Success) throw new InvalidOperationException("团队请输入纯数字 ID，或完整的 ACGO 团队页面 URL。");
            string teamId = teamMatch.Groups[1].Value;
            if (!homeworkEnabled.Checked && !contestEnabled.Checked)
                throw new InvalidOperationException("作业和竞赛至少选择一个。");
            string selectedHomework = homeworkId.Text.Trim();
            string selectedContest = contestId.Text.Trim();
            if (homeworkEnabled.Checked && !Regex.IsMatch(selectedHomework, @"^\d+$"))
                throw new InvalidOperationException("请输入有效的数字作业 ID。");
            if (contestEnabled.Checked && !Regex.IsMatch(selectedContest, @"^\d+$"))
                throw new InvalidOperationException("请输入有效的数字竞赛 ID。");

            string packageName = sessionName.Text.Trim();
            if (string.IsNullOrWhiteSpace(packageName)) packageName = "ACGO-代码证据包";
            string selectedPrompt = promptPath.Text.Trim();
            if (string.IsNullOrWhiteSpace(selectedPrompt)) throw new InvalidOperationException("必须选择完整的 AI 提示词文件；默认文件是程序同目录的 提示词.md。");
            selectedPrompt = Path.GetFullPath(selectedPrompt);
            if (!File.Exists(selectedPrompt)) throw new FileNotFoundException("找不到 AI 提示词：" + selectedPrompt + "。请在程序同目录放置 提示词.md，或选择其他文件。");
            if (string.IsNullOrWhiteSpace(File.ReadAllText(selectedPrompt, Encoding.UTF8))) throw new InvalidDataException("AI 提示词文件为空：" + selectedPrompt);

            List<string> targets = new List<string>();
            if (homeworkEnabled.Checked) targets.Add("homework");
            if (contestEnabled.Checked) targets.Add("contest");
            StringBuilder json = new StringBuilder();
            json.AppendLine("{");
            json.AppendLine("  \"targets\": [" + string.Join(", ", targets.Select(JsonString)) + "],");
            if (homeworkEnabled.Checked)
            {
                json.AppendLine("  \"homework\": { \"id\": " + JsonString(selectedHomework) + ", \"teamCode\": " + JsonString(teamId) + " },");
            }
            if (contestEnabled.Checked)
            {
                json.AppendLine("  \"contest\": { \"id\": " + JsonString(selectedContest) + ", \"teamCode\": " + JsonString(teamId) + " },");
            }
            json.AppendLine("  \"sessionName\": " + JsonString(packageName) + ",");
            json.AppendLine("  \"promptPath\": " + JsonString(selectedPrompt) + ",");
            json.AppendLine("  \"teacherUserIds\": [\"4741656\"],");
            json.AppendLine("  \"cdpUrl\": \"http://127.0.0.1:9222\",");
            json.AppendLine("  \"browser\": {");
            json.AppendLine("    \"autoLaunch\": true,");
            json.AppendLine("    \"startupTimeoutMs\": 20000,");
            json.AppendLine("    \"loginTimeoutMs\": 600000,");
            json.AppendLine("    \"closeOnFinish\": false");
            json.AppendLine("  },");
            json.AppendLine("  \"outputDirectory\": \"output\",");
            json.AppendLine("  \"navigationTimeoutMs\": 30000,");
            json.AppendLine("  \"questionApiConcurrency\": 4,");
            json.AppendLine("  \"submissionApiConcurrency\": 4,");
            json.AppendLine("  \"submissionDetailConcurrency\": 3,");
            json.AppendLine("  \"apiRetryCount\": 3,");
            json.AppendLine("  \"maxRankingPages\": 100,");
            json.AppendLine("  \"saveDebugFiles\": false");
            json.AppendLine("}");

            string temporaryDirectory = Path.Combine(Path.GetTempPath(), "ACGO-Crawler");
            Directory.CreateDirectory(temporaryDirectory);
            generatedConfigPath = Path.Combine(temporaryDirectory, "run-" + Guid.NewGuid().ToString("N") + ".json");
            File.WriteAllText(generatedConfigPath, json.ToString(), new UTF8Encoding(false));
            return generatedConfigPath;
        }

        private static string JsonString(string value)
        {
            StringBuilder result = new StringBuilder("\"");
            foreach (char character in value ?? string.Empty)
            {
                switch (character)
                {
                    case '\\': result.Append("\\\\"); break;
                    case '"': result.Append("\\\""); break;
                    case '\r': result.Append("\\r"); break;
                    case '\n': result.Append("\\n"); break;
                    case '\t': result.Append("\\t"); break;
                    default:
                        if (character < 32) result.Append("\\u" + ((int)character).ToString("x4", CultureInfo.InvariantCulture));
                        else result.Append(character);
                        break;
                }
            }
            return result.Append('"').ToString();
        }

        private void HandleCrawlerLine(string line)
        {
            Match zipMatch = Regex.Match(line, @"ZIP\s*已生成[：:]\s*(.+)$", RegexOptions.IgnoreCase);
            if (zipMatch.Success)
            {
                string candidate = zipMatch.Groups[1].Value.Trim().Trim('"');
                if (!Path.IsPathRooted(candidate)) candidate = Path.GetFullPath(Path.Combine(appRoot, candidate));
                resultZipPath = candidate;
            }
            AppendLogThreadSafe(line + "\r\n");
        }

        private string FindLatestZip()
        {
            string output = Path.Combine(appRoot, "output");
            if (!Directory.Exists(output)) return null;
            return Directory.EnumerateFiles(output, "*.zip", SearchOption.AllDirectories)
                .Select(filename => new FileInfo(filename))
                .Where(info => info.LastWriteTime >= runStartedAt.AddSeconds(-3))
                .OrderByDescending(info => info.LastWriteTime)
                .Select(info => info.FullName)
                .FirstOrDefault();
        }

        private void SetRunning(bool running, string status)
        {
            startButton.Enabled = !running;
            stopButton.Enabled = running;
            interactiveMode.Enabled = !running;
            configMode.Enabled = !running;
            progressBar.Style = running ? ProgressBarStyle.Marquee : ProgressBarStyle.Blocks;
            progressBar.MarqueeAnimationSpeed = running ? 25 : 0;
            statusLabel.Text = status;
            if (!running) UpdateMode();
        }

        private void StopRun()
        {
            Process process = crawlerProcess;
            if (process == null || process.HasExited) return;
            DialogResult answer = MessageBox.Show(this, "确定停止当前任务吗？Node 任务会停止；为便于继续登录或排错，专用 Edge 可能保留，可按需手动关闭。", "停止任务", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
            if (answer != DialogResult.Yes) return;
            AppendLog("[启动器] 正在停止任务……\r\n");
            RuntimeManager.TerminateProcessTree(process.Id);
        }

        private void OpenResult()
        {
            if (string.IsNullOrWhiteSpace(resultZipPath) || !File.Exists(resultZipPath)) return;
            Process.Start(new ProcessStartInfo("explorer.exe", "/select," + Quote(resultZipPath)) { UseShellExecute = true });
        }

        private void HandleFormClosing(object sender, FormClosingEventArgs eventArgs)
        {
            Process process = crawlerProcess;
            if (process == null || process.HasExited || allowClose) return;
            DialogResult answer = MessageBox.Show(this, "任务仍在运行。关闭启动器会停止 Node 任务；专用 Edge 可能保留，可按需手动关闭。确定关闭吗？", "任务运行中", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
            if (answer == DialogResult.No)
            {
                eventArgs.Cancel = true;
                return;
            }
            allowClose = true;
            RuntimeManager.TerminateProcessTree(process.Id);
        }

        private void CleanupTemporaryConfig()
        {
            try
            {
                if (!string.IsNullOrWhiteSpace(generatedConfigPath) && File.Exists(generatedConfigPath)) File.Delete(generatedConfigPath);
            }
            catch { }
            generatedConfigPath = null;
        }

        private void AppendLogThreadSafe(string text)
        {
            if (IsDisposed) return;
            if (InvokeRequired)
            {
                try { BeginInvoke(new Action<string>(AppendLog), text); }
                catch (InvalidOperationException) { }
                return;
            }
            AppendLog(text);
        }

        private void AppendLog(string text)
        {
            logBox.AppendText(text);
            logBox.SelectionStart = logBox.TextLength;
            logBox.ScrollToCaret();
        }

        private static string Quote(string value)
        {
            return "\"" + String(value).Replace("\"", "\\\"") + "\"";
        }

        private static string String(string value)
        {
            return value ?? string.Empty;
        }
    }

    internal static class ProjectLayout
    {
        public static void Validate(string appRoot)
        {
            string entry = Path.Combine(appRoot, "src", "index.mjs");
            string configModule = Path.Combine(appRoot, "src", "config.mjs");
            string dependency = Path.Combine(appRoot, "node_modules", "playwright-core", "package.json");
            string prompt = Path.Combine(appRoot, "提示词.md");
            if (!File.Exists(entry)) throw new FileNotFoundException("安装包不完整，缺少 src/index.mjs。请复制完整的 ACGO-Crawler 目录。", entry);
            if (!File.Exists(configModule)) throw new FileNotFoundException("安装包不完整，缺少 src/config.mjs。请重新构建完整发布包。", configModule);
            if (!File.Exists(dependency)) throw new FileNotFoundException("安装包不完整，缺少生产依赖 node_modules/playwright-core。请重新构建完整发布包。", dependency);
            if (!File.Exists(prompt) || string.IsNullOrWhiteSpace(File.ReadAllText(prompt, Encoding.UTF8))) throw new FileNotFoundException("安装包不完整，缺少非空 提示词.md。请重新构建完整发布包。", prompt);
            RuntimeManager.ValidateRuntimeBundlePair(appRoot);
        }
    }

    internal static class RuntimeManager
    {
        private static readonly Regex VersionPattern = new Regex(@"^v?(\d+)\.", RegexOptions.Compiled);

        public static string ResolveNode(string appRoot, Action<string> log)
        {
            bool forceBundledRuntime = string.Equals(
                Environment.GetEnvironmentVariable("ACGO_CRAWLER_FORCE_BUNDLED_RUNTIME", EnvironmentVariableTarget.Process),
                "1",
                StringComparison.Ordinal
            );
            string systemNode = forceBundledRuntime ? null : FindOnPath("node.exe");
            if (!string.IsNullOrWhiteSpace(systemNode))
            {
                try
                {
                    ValidateNodeVersion(systemNode);
                    log("[启动器] 使用系统 Node：" + systemNode + "\r\n");
                    return systemNode;
                }
                catch (Exception error)
                {
                    log("[启动器] 系统 Node 不符合要求（" + error.Message + "），改用配套运行时。\r\n");
                }
            }

            string runtimeRoot = Path.Combine(appRoot, "runtime");
            string extractedRoot = Path.Combine(runtimeRoot, "node");
            string extractedNode = FindFile(extractedRoot, "node.exe");
            if (!string.IsNullOrWhiteSpace(extractedNode))
            {
                try
                {
                    ValidateNodeVersion(extractedNode);
                    log("[启动器] 使用已解压的配套 Node。\r\n");
                    return extractedNode;
                }
                catch { }
            }

            string archive = Path.Combine(runtimeRoot, "node-runtime.zip");
            if (!File.Exists(archive))
            {
                throw new FileNotFoundException("未检测到 Node 20+，且缺少配套文件 runtime/node-runtime.zip。请重新获取完整发布包。", archive);
            }
            ValidateArchiveHash(archive);

            Directory.CreateDirectory(runtimeRoot);
            string temporaryRoot = Path.Combine(runtimeRoot, ".node-extract-" + Guid.NewGuid().ToString("N"));
            log("[启动器] 未检测到可用 Node，正在解压配套运行时……\r\n");
            try
            {
                ExtractRequiredRuntimeFiles(archive, temporaryRoot);
                string temporaryNode = FindFile(temporaryRoot, "node.exe");
                if (string.IsNullOrWhiteSpace(temporaryNode)) throw new InvalidDataException("node-runtime.zip 中没有 node.exe。");
                ValidateNodeVersion(temporaryNode);
                if (Directory.Exists(extractedRoot)) Directory.Delete(extractedRoot, true);
                Directory.Move(temporaryRoot, extractedRoot);
                extractedNode = FindFile(extractedRoot, "node.exe");
                log("[启动器] Node 运行时解压完成。\r\n");
                return extractedNode;
            }
            catch
            {
                if (Directory.Exists(temporaryRoot)) Directory.Delete(temporaryRoot, true);
                throw;
            }
        }

        public static void ValidateNodeVersion(string nodePath)
        {
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = nodePath;
            info.Arguments = "--version";
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            using (Process process = Process.Start(info))
            {
                string version = process.StandardOutput.ReadToEnd().Trim();
                string error = process.StandardError.ReadToEnd().Trim();
                if (!process.WaitForExit(10000))
                {
                    process.Kill();
                    throw new InvalidOperationException("Node 版本检查超时。");
                }
                if (process.ExitCode != 0) throw new InvalidOperationException("Node 无法运行：" + error);
                Match match = VersionPattern.Match(version);
                int major;
                if (!match.Success || !int.TryParse(match.Groups[1].Value, out major) || major < 20)
                    throw new InvalidOperationException("需要 Node 20 或更高版本，当前为 " + version + "。");
            }
        }

        private static string FindOnPath(string filename)
        {
            // 只遵循当前进程收到的 PATH。显式传入空 PATH 的隔离测试和受管环境
            // 不应被 Environment 的目标作用域回退重新注入系统 Node。
            string pathValue = Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.Process);
            if (pathValue == null) pathValue = string.Empty;
            foreach (string rawDirectory in pathValue.Split(Path.PathSeparator))
            {
                string directory = rawDirectory.Trim().Trim('"');
                if (string.IsNullOrWhiteSpace(directory)) continue;
                try
                {
                    string candidate = Path.Combine(directory, filename);
                    if (File.Exists(candidate)) return Path.GetFullPath(candidate);
                }
                catch { }
            }
            return null;
        }

        private static string FindFile(string root, string filename)
        {
            if (!Directory.Exists(root)) return null;
            try { return Directory.EnumerateFiles(root, filename, SearchOption.AllDirectories).FirstOrDefault(); }
            catch { return null; }
        }

        public static void ValidateRuntimeBundlePair(string appRoot)
        {
            string runtimeRoot = Path.Combine(appRoot, "runtime");
            string archive = Path.Combine(runtimeRoot, "node-runtime.zip");
            string hashFile = Path.Combine(runtimeRoot, "node-runtime.sha256");
            bool archiveExists = File.Exists(archive);
            bool hashExists = File.Exists(hashFile);
            if (!archiveExists && !hashExists) return;
            if (archiveExists && hashExists)
            {
                ValidateArchiveHash(archive);
                return;
            }

            string missing = archiveExists ? hashFile : archive;
            throw new FileNotFoundException(
                "配套 Node 运行时不完整：node-runtime.zip 与 node-runtime.sha256 必须同时存在。请重新获取完整发布包。",
                missing
            );
        }

        private static void ValidateArchiveHash(string archive)
        {
            string hashFile = Path.Combine(Path.GetDirectoryName(archive), "node-runtime.sha256");
            if (!File.Exists(hashFile))
                throw new FileNotFoundException("缺少 runtime/node-runtime.sha256，拒绝解压未经校验的配套 Node 运行时。请重新获取完整发布包。", hashFile);
            string expected = File.ReadAllText(hashFile).Trim().Split(new[] { ' ', '\t', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
            if (string.IsNullOrWhiteSpace(expected) || !Regex.IsMatch(expected, @"^[0-9a-fA-F]{64}$"))
                throw new InvalidDataException("node-runtime.sha256 必须包含 64 位十六进制 SHA-256。请重新获取完整发布包。");
            string actual;
            using (SHA256 algorithm = SHA256.Create())
            using (FileStream stream = File.OpenRead(archive))
            {
                actual = BitConverter.ToString(algorithm.ComputeHash(stream)).Replace("-", string.Empty);
            }
            if (!string.Equals(expected, actual, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("配套 Node 运行时校验失败，文件可能不完整或已被修改。请重新获取发布包。");
        }

        private static void ExtractRequiredRuntimeFiles(string archive, string destination)
        {
            string destinationPrefix = Path.GetFullPath(destination).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            Directory.CreateDirectory(destinationPrefix);
            using (ZipArchive zip = ZipFile.OpenRead(archive))
            {
                ZipArchiveEntry nodeEntry = zip.Entries
                    .Where(entry => string.Equals(entry.Name, "node.exe", StringComparison.OrdinalIgnoreCase))
                    .OrderBy(entry => entry.FullName.Length)
                    .FirstOrDefault();
                if (nodeEntry == null) throw new InvalidDataException("node-runtime.zip 中没有 node.exe。");

                // 爬虫只需要 node.exe；npm 已在构建阶段执行，生产依赖已随发行目录复制。
                // 只提取必需运行时可规避未启用 Windows LongPaths 时完整 Node 包的深层路径超限。
                string nodeTarget = Path.GetFullPath(Path.Combine(destinationPrefix, "node.exe"));
                if (!nodeTarget.StartsWith(destinationPrefix, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("运行时目标路径非法。");
                nodeEntry.ExtractToFile(nodeTarget, true);

                ZipArchiveEntry licenseEntry = zip.Entries
                    .Where(entry => string.Equals(entry.Name, "LICENSE", StringComparison.OrdinalIgnoreCase))
                    .OrderBy(entry => entry.FullName.Length)
                    .FirstOrDefault();
                if (licenseEntry != null) licenseEntry.ExtractToFile(Path.Combine(destinationPrefix, "NODE-LICENSE.txt"), true);
            }
        }

        public static void TerminateProcessTree(int processId)
        {
            try
            {
                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "taskkill.exe");
                info.Arguments = "/PID " + processId.ToString(CultureInfo.InvariantCulture) + " /T /F";
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                using (Process process = Process.Start(info)) process.WaitForExit(10000);
            }
            catch
            {
                try
                {
                    using (Process process = Process.GetProcessById(processId)) process.Kill();
                }
                catch { }
            }
        }
    }
}
