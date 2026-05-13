using System.Runtime.InteropServices;
using Microsoft.VisualStudio.Shell;

namespace JuniorStudio.VisualStudio.ToolWindows
{
    [Guid("792c77f0-e126-4f35-aaac-104936e199cb")]
    public class JuniorChatToolWindow : ToolWindowPane
    {
        public JuniorChatToolWindow() : base(null)
        {
            Caption = "Junior Chat";
            Content = new JuniorChatToolWindowControl();
        }
    }
}