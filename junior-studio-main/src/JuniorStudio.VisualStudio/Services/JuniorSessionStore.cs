using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Web.Script.Serialization;

namespace JuniorStudio.VisualStudio.Services
{
    /// <summary>
    /// File-backed JSON store for chat sessions. Each session lives in its own
    /// file under <c>%LOCALAPPDATA%\JuniorStudio\sessions</c> so reads/writes are
    /// cheap and a corrupted file can't take down the whole list.
    /// </summary>
    internal sealed class JuniorSessionStore
    {
        private readonly JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 };
        private readonly string root;

        public JuniorSessionStore()
        {
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            root = Path.Combine(local, "JuniorStudio", "sessions");
            try { Directory.CreateDirectory(root); } catch { }
        }

        public List<JuniorSessionMeta> ListSessions()
        {
            var results = new List<JuniorSessionMeta>();
            if (!Directory.Exists(root)) return results;
            foreach (var path in Directory.EnumerateFiles(root, "*.json"))
            {
                try
                {
                    var session = LoadFile(path);
                    if (session == null) continue;
                    results.Add(new JuniorSessionMeta
                    {
                        Id = session.Id,
                        Title = string.IsNullOrWhiteSpace(session.Title) ? "(untitled)" : session.Title,
                        CreatedAt = session.CreatedAt,
                        UpdatedAt = session.UpdatedAt,
                        MessageCount = CountConversational(session)
                    });
                }
                catch { /* skip unreadable */ }
            }
            return results.OrderByDescending(s => s.UpdatedAt).ToList();
        }

        public JuniorSession Load(string id)
        {
            if (string.IsNullOrEmpty(id)) return null;
            var path = PathFor(id);
            return File.Exists(path) ? LoadFile(path) : null;
        }

        public void Save(JuniorSession session)
        {
            if (session == null || string.IsNullOrEmpty(session.Id)) return;
            session.UpdatedAt = NowMs();
            try
            {
                Directory.CreateDirectory(root);
                var json = serializer.Serialize(session);
                File.WriteAllText(PathFor(session.Id), json);
            }
            catch { /* best-effort persistence */ }
        }

        public bool Delete(string id)
        {
            if (string.IsNullOrEmpty(id)) return false;
            try
            {
                var path = PathFor(id);
                if (File.Exists(path)) { File.Delete(path); return true; }
            }
            catch { }
            return false;
        }

        public JuniorSession CreateNew(string title)
        {
            var now = NowMs();
            return new JuniorSession
            {
                Id = Guid.NewGuid().ToString("n"),
                Title = string.IsNullOrWhiteSpace(title) ? "New chat" : Truncate(title, 80),
                CreatedAt = now,
                UpdatedAt = now,
                Items = new List<JuniorSessionItem>()
            };
        }

        public static string Truncate(string text, int max)
        {
            if (string.IsNullOrEmpty(text)) return string.Empty;
            text = text.Replace("\r", " ").Replace("\n", " ").Trim();
            return text.Length <= max ? text : text.Substring(0, max - 1) + "\u2026";
        }

        public static long NowMs()
        {
            return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        }

        private string PathFor(string id)
        {
            // Sessions ids are GUIDs; sanitize defensively anyway.
            var safe = new string(id.Where(c => char.IsLetterOrDigit(c) || c == '-' || c == '_').ToArray());
            if (safe.Length == 0) safe = Guid.NewGuid().ToString("n");
            return Path.Combine(root, safe + ".json");
        }

        private JuniorSession LoadFile(string path)
        {
            var raw = File.ReadAllText(path);
            if (string.IsNullOrWhiteSpace(raw)) return null;
            var dict = serializer.Deserialize<Dictionary<string, object>>(raw);
            if (dict == null) return null;
            var session = new JuniorSession
            {
                Id = dict.TryGetValue("Id", out var id) ? Convert.ToString(id) : null,
                Title = dict.TryGetValue("Title", out var t) ? Convert.ToString(t) : null,
                CreatedAt = dict.TryGetValue("CreatedAt", out var c) ? ToLong(c) : 0,
                UpdatedAt = dict.TryGetValue("UpdatedAt", out var u) ? ToLong(u) : 0,
                Items = new List<JuniorSessionItem>()
            };
            if (dict.TryGetValue("Items", out var items) && items is System.Collections.IEnumerable iarr)
            {
                foreach (var entry in iarr)
                {
                    if (entry is Dictionary<string, object> ie)
                    {
                        var kind = ie.TryGetValue("Kind", out var k) ? Convert.ToString(k) : null;
                        Dictionary<string, object> payload = null;
                        if (ie.TryGetValue("Payload", out var pv) && pv is Dictionary<string, object> pd)
                            payload = pd;
                        if (!string.IsNullOrEmpty(kind))
                            session.Items.Add(new JuniorSessionItem { Kind = kind, Payload = payload ?? new Dictionary<string, object>() });
                    }
                }
            }
            else if (dict.TryGetValue("Messages", out var msgs) && msgs is System.Collections.IEnumerable arr)
            {
                // Backward-compat: convert legacy {Role,Text,Timestamp} messages to items.
                foreach (var entry in arr)
                {
                    if (entry is Dictionary<string, object> m)
                    {
                        var role = m.TryGetValue("Role", out var r) ? Convert.ToString(r) : "user";
                        var text = m.TryGetValue("Text", out var x) ? Convert.ToString(x) : string.Empty;
                        session.Items.Add(new JuniorSessionItem
                        {
                            Kind = string.Equals(role, "assistant", StringComparison.OrdinalIgnoreCase) ? "assistant" : "user",
                            Payload = new Dictionary<string, object> { ["text"] = text }
                        });
                    }
                }
            }
            if (string.IsNullOrEmpty(session.Id)) return null;
            return session;
        }

        private static int CountConversational(JuniorSession session)
        {
            if (session?.Items == null) return 0;
            var n = 0;
            foreach (var item in session.Items)
            {
                if (item.Kind == "user" || item.Kind == "assistant") n++;
            }
            return n;
        }

        private static long ToLong(object value)
        {
            try { return Convert.ToInt64(value); }
            catch { return 0; }
        }
    }

    internal sealed class JuniorSession
    {
        public string Id { get; set; }
        public string Title { get; set; }
        public long CreatedAt { get; set; }
        public long UpdatedAt { get; set; }
        public List<JuniorSessionItem> Items { get; set; }
    }

    internal sealed class JuniorSessionItem
    {
        public string Kind { get; set; }
        public Dictionary<string, object> Payload { get; set; }
    }

    internal sealed class JuniorSessionMessage
    {
        public string Role { get; set; }
        public string Text { get; set; }
        public long Timestamp { get; set; }
    }

    internal sealed class JuniorSessionMeta
    {
        public string Id { get; set; }
        public string Title { get; set; }
        public long CreatedAt { get; set; }
        public long UpdatedAt { get; set; }
        public int MessageCount { get; set; }
    }
}
