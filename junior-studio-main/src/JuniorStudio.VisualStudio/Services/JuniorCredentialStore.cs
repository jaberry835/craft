using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace JuniorStudio.VisualStudio.Services
{
    internal static class JuniorCredentialStore
    {
        private const string Prefix = "cred:";
        private const int CredentialTypeGeneric = 1;
        private const int CredentialPersistLocalMachine = 2;

        public static bool IsCredentialReference(string value)
        {
            return !string.IsNullOrWhiteSpace(value) && value.TrimStart().StartsWith(Prefix, StringComparison.OrdinalIgnoreCase);
        }

        public static string CreateApiKeyTarget(string provider, string deployment)
        {
            return "JuniorStudio/" + SanitizeSegment(provider, "Provider") + "/" + SanitizeSegment(deployment, "default") + "/ApiKey";
        }

        public static string ToReference(string target)
        {
            return Prefix + target;
        }

        public static string ResolveSecretReference(string value)
        {
            if (!IsCredentialReference(value)) return value ?? string.Empty;
            var target = value.Trim().Substring(Prefix.Length).Trim();
            if (target.Length == 0) return string.Empty;
            return ReadSecret(target) ?? string.Empty;
        }

        public static void WriteSecret(string target, string secret)
        {
            if (string.IsNullOrWhiteSpace(target)) throw new ArgumentException("Credential target is required.", nameof(target));
            if (secret == null) throw new ArgumentNullException(nameof(secret));

            var secretBytes = Encoding.Unicode.GetBytes(secret);
            if (secretBytes.Length > 5120)
                throw new InvalidOperationException("Credential Manager secrets are limited to 5120 bytes.");

            var credential = new NativeCredential
            {
                Type = CredentialTypeGeneric,
                TargetName = target,
                UserName = "JuniorStudio",
                CredentialBlobSize = (uint)secretBytes.Length,
                Persist = CredentialPersistLocalMachine,
                AttributeCount = 0
            };

            var blob = IntPtr.Zero;
            try
            {
                blob = Marshal.AllocCoTaskMem(secretBytes.Length);
                Marshal.Copy(secretBytes, 0, blob, secretBytes.Length);
                credential.CredentialBlob = blob;
                if (!CredWrite(ref credential, 0))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            finally
            {
                if (blob != IntPtr.Zero)
                {
                    Marshal.Copy(new byte[secretBytes.Length], 0, blob, secretBytes.Length);
                    Marshal.FreeCoTaskMem(blob);
                }
            }
        }

        public static string ReadSecret(string target)
        {
            if (string.IsNullOrWhiteSpace(target)) return string.Empty;
            if (!CredRead(target, CredentialTypeGeneric, 0, out var credentialPtr)) return string.Empty;

            try
            {
                var credential = (NativeCredential)Marshal.PtrToStructure(credentialPtr, typeof(NativeCredential));
                if (credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize == 0) return string.Empty;
                var bytes = new byte[credential.CredentialBlobSize];
                Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
                return Encoding.Unicode.GetString(bytes).TrimEnd('\0');
            }
            finally
            {
                CredFree(credentialPtr);
            }
        }

        private static string SanitizeSegment(string value, string fallback)
        {
            var raw = string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
            var builder = new StringBuilder(raw.Length);
            foreach (var ch in raw)
            {
                if (char.IsLetterOrDigit(ch) || ch == '-' || ch == '_' || ch == '.') builder.Append(ch);
                else builder.Append('_');
            }
            return builder.Length == 0 ? fallback : builder.ToString();
        }

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredWrite(ref NativeCredential userCredential, uint flags);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);

        [DllImport("advapi32.dll", SetLastError = false)]
        private static extern void CredFree(IntPtr buffer);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct NativeCredential
        {
            public uint Flags;
            public uint Type;
            public string TargetName;
            public string Comment;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
            public uint CredentialBlobSize;
            public IntPtr CredentialBlob;
            public uint Persist;
            public uint AttributeCount;
            public IntPtr Attributes;
            public string TargetAlias;
            public string UserName;
        }
    }
}