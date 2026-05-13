using System;
using System.ComponentModel.Design;
using Microsoft.VisualStudio.Shell;
using JuniorStudio.VisualStudio.ToolWindows;
using Task = System.Threading.Tasks.Task;

namespace JuniorStudio.VisualStudio.Commands
{
    internal sealed class OpenJuniorChatCommand
    {
        public const int CommandId = 0x0100;
        public static readonly Guid CommandSet = new Guid("8c3bbdfc-302d-4c40-9f0c-c94f5b2f5868");

        private readonly AsyncPackage package;

        private OpenJuniorChatCommand(AsyncPackage package, OleMenuCommandService commandService)
        {
            this.package = package ?? throw new ArgumentNullException(nameof(package));
            commandService = commandService ?? throw new ArgumentNullException(nameof(commandService));

            var menuCommandId = new CommandID(CommandSet, CommandId);
            var menuItem = new MenuCommand(Execute, menuCommandId);
            commandService.AddCommand(menuItem);
        }

        public static OpenJuniorChatCommand Instance { get; private set; }

        public static async Task InitializeAsync(AsyncPackage package)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync(package.DisposalToken);
            var commandService = await package.GetServiceAsync(typeof(IMenuCommandService)) as OleMenuCommandService;
            Instance = new OpenJuniorChatCommand(package, commandService);
        }

        private void Execute(object sender, EventArgs e)
        {
            package.JoinableTaskFactory.RunAsync(async delegate
            {
                var window = await package.ShowToolWindowAsync(typeof(JuniorChatToolWindow), 0, true, package.DisposalToken);
                if (window?.Frame == null)
                {
                    throw new NotSupportedException("Cannot create Junior Chat tool window.");
                }
            }).FileAndForget("JuniorStudio/OpenJuniorChat");
        }
    }
}