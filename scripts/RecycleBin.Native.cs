using System;
using System.Runtime.InteropServices;
using System.Text;

namespace FixStorage
{
    [ComImport]
    [Guid("3AD05575-8857-4850-9277-11B85BDB8E09")]
    public class FileOperationComObject { }

    [ComImport]
    [Guid("947AAB5F-0A5C-4C13-B4A6-4BF7E2A41DD0")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IFileOperation
    {
        [PreserveSig] int Advise(IntPtr sink, out uint cookie);
        [PreserveSig] int Unadvise(uint cookie);
        [PreserveSig] int SetOperationFlags(uint flags);
        [PreserveSig] int SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string message);
        [PreserveSig] int SetProgressDialog(IntPtr dialog);
        [PreserveSig] int SetProperties(IntPtr properties);
        [PreserveSig] int SetOwnerWindow(IntPtr owner);
        [PreserveSig] int ApplyPropertiesToItem(IntPtr item);
        [PreserveSig] int ApplyPropertiesToItems(IntPtr items);
        [PreserveSig] int RenameItem(IntPtr item, IntPtr name, IntPtr sink);
        [PreserveSig] int RenameItems(IntPtr items, IntPtr name);
        [PreserveSig] int MoveItem(IntPtr item, IntPtr destination, IntPtr name, IntPtr sink);
        [PreserveSig] int MoveItems(IntPtr items, IntPtr destination);
        [PreserveSig] int CopyItem(IntPtr item, IntPtr destination, IntPtr name, IntPtr sink);
        [PreserveSig] int CopyItems(IntPtr items, IntPtr destination);
        [PreserveSig] int DeleteItem(
            [MarshalAs(UnmanagedType.Interface)] object item,
            [MarshalAs(UnmanagedType.Interface)] object sink);
        [PreserveSig] int DeleteItems(IntPtr items);
        [PreserveSig] int NewItem(IntPtr destination, uint attributes, IntPtr name, IntPtr template, IntPtr sink);
        [PreserveSig] int PerformOperations();
        [PreserveSig] int GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
    }

    [ComImport]
    [Guid("04B0F1A7-9490-44BC-96E1-4296A31252E2")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IFileOperationProgressSink
    {
        [PreserveSig] int StartOperations();
        [PreserveSig] int FinishOperations(int result);
        [PreserveSig] int PreRenameItem(uint flags, IntPtr item, string newName);
        [PreserveSig] int PostRenameItem(uint flags, IntPtr item, string newName, int result, IntPtr newlyCreated);
        [PreserveSig] int PreMoveItem(uint flags, IntPtr item, IntPtr destination, string newName);
        [PreserveSig] int PostMoveItem(uint flags, IntPtr item, IntPtr destination, string newName, int result, IntPtr newlyCreated);
        [PreserveSig] int PreCopyItem(uint flags, IntPtr item, IntPtr destination, string newName);
        [PreserveSig] int PostCopyItem(uint flags, IntPtr item, IntPtr destination, string newName, int result, IntPtr newlyCreated);
        [PreserveSig] int PreDeleteItem(uint flags, IntPtr item);
        [PreserveSig] int PostDeleteItem(uint flags, IntPtr item, int result, IntPtr newlyCreated);
        [PreserveSig] int PreNewItem(uint flags, IntPtr destination, string newName, string templateName);
        [PreserveSig] int PostNewItem(uint flags, IntPtr destination, string newName, string templateName, uint attributes, int result, IntPtr newItem);
        [PreserveSig] int UpdateProgress(uint total, uint completed);
        [PreserveSig] int ResetTimer();
        [PreserveSig] int PauseTimer();
        [PreserveSig] int ResumeTimer();
    }

    [ComImport]
    [Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellItem
    {
        [PreserveSig] int BindToHandler(IntPtr bindContext, ref Guid handlerId, ref Guid interfaceId, out IntPtr result);
        [PreserveSig] int GetParent(out IntPtr parent);
        [PreserveSig] int GetDisplayName(int sigdnName, out IntPtr name);
        [PreserveSig] int GetAttributes(uint mask, out uint attributes);
        [PreserveSig] int Compare(IntPtr other, uint hint, out int order);
    }

    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.None)]
    public sealed class RecycleGuard : IFileOperationProgressSink
    {
        public const uint RecycleIfPossible = 0x80;
        public const int Abort = unchecked((int)0x80004004);

        public bool SawPre;
        public bool SawPost;
        public bool SawFinish;
        public int DeleteCallbacks;
        public string Failure;

        public int StartOperations() { return 0; }
        public int FinishOperations(int result)
        {
            SawFinish = true;
            if (result < 0) Failure = String.Format("Shell reported final failure HRESULT 0x{0:X8}.", result);
            return result < 0 ? result : 0;
        }
        public int PreRenameItem(uint flags, IntPtr item, string newName) { return 0; }
        public int PostRenameItem(uint flags, IntPtr item, string newName, int result, IntPtr newlyCreated) { return 0; }
        public int PreMoveItem(uint flags, IntPtr item, IntPtr destination, string newName) { return 0; }
        public int PostMoveItem(uint flags, IntPtr item, IntPtr destination, string newName, int result, IntPtr newlyCreated) { return 0; }
        public int PreCopyItem(uint flags, IntPtr item, IntPtr destination, string newName) { return 0; }
        public int PostCopyItem(uint flags, IntPtr item, IntPtr destination, string newName, int result, IntPtr newlyCreated) { return 0; }

        public int PreDeleteItem(uint flags, IntPtr item)
        {
            if ((flags & RecycleIfPossible) == 0)
            {
                Failure = "Shell did not mark this operation as recycle-if-possible before deletion; the operation was cancelled before scheduling.";
                return Abort;
            }
            SawPre = true;
            return 0;
        }

        public int PostDeleteItem(uint flags, IntPtr item, int result, IntPtr newlyCreated)
        {
            DeleteCallbacks++;
            SawPost = true;
            if (result < 0)
            {
                Failure = String.Format("Shell delete failed with HRESULT 0x{0:X8}; the source may already have been removed.", result);
                return Abort;
            }
            // Microsoft documents psiNewlyCreated as non-null only when the
            // deleted item is now in the Recycle Bin. Full deletion supplies NULL.
            if ((flags & RecycleIfPossible) == 0 || newlyCreated == IntPtr.Zero)
            {
                Failure = "Shell did not provide a Recycle Bin destination; the source may already have been permanently deleted. Manual inspection is required. No fallback was attempted.";
                return Abort;
            }
            return 0;
        }

        public int PreNewItem(uint flags, IntPtr destination, string newName, string templateName) { return 0; }
        public int PostNewItem(uint flags, IntPtr destination, string newName, string templateName, uint attributes, int result, IntPtr newItem) { return 0; }
        public int UpdateProgress(uint total, uint completed) { return 0; }
        public int ResetTimer() { return 0; }
        public int PauseTimer() { return 0; }
        public int ResumeTimer() { return 0; }
    }

    public sealed class RecycleResult
    {
        public string Path { get; set; }
        public bool Success { get; set; }
        public string Error { get; set; }
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct SHQUERYRBINFO
    {
        public int cbSize;
        public long i64Size;
        public long i64NumItems;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct FileTime
    {
        public uint Low;
        public uint High;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct ByHandleFileInformation
    {
        public uint FileAttributes;
        public FileTime CreationTime;
        public FileTime LastAccessTime;
        public FileTime LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    /** Verified state; Unverified must fail closed. */
    public enum PolicyState
    {
        Enabled,
        Disabled,
        Unverified
    }

    public static class NativeRecycle
    {
        private const uint RecycleOnDelete = 0x00080000;
        private const uint EarlyFailure = 0x00100000;
        private const uint AddUndoRecord = 0x20000000;
        private const uint NoErrorUi = 0x00000400;
        private const uint NoConfirmation = 0x00000010;
        private const uint Silent = 0x00000004;
        private const uint ApartmentThreaded = 0x2;
        private const int SigdnFilePath = unchecked((int)0x80058000);
        private const uint DriveUnknown = 0;
        private const uint DriveNoRoot = 1;
        private const uint DriveRemovable = 2;
        private const uint DriveFixed = 3;
        private const uint DriveRemote = 4;
        private const uint DriveCdrom = 5;
        private const uint DriveRamdisk = 6;
        private const uint KeyRead = 0x20019;
        private const int ErrorFileNotFound = 2;
        private const uint FileAttributeReparsePoint = 0x00000400;
        private const uint FileFlagBackupSemantics = 0x02000000;
        private const uint FileFlagOpenReparsePoint = 0x00200000;
        private const uint FileShareAll = 0x00000007;
        private const uint OpenExisting = 3;
        private static readonly IntPtr InvalidHandle = new IntPtr(-1);
        private static readonly Guid ShellItemGuid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
        private static readonly IntPtr HKeyCurrentUser = new IntPtr(unchecked((int)0x80000001));
        private static readonly IntPtr HKeyLocalMachine = new IntPtr(unchecked((int)0x80000002));

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        private static extern int SHCreateItemFromParsingName(
            [MarshalAs(UnmanagedType.LPWStr)] string path,
            IntPtr bindContext,
            ref Guid interfaceId,
            [MarshalAs(UnmanagedType.Interface)] out object shellItem);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        private static extern int SHQueryRecycleBinW(
            [MarshalAs(UnmanagedType.LPWStr)] string rootPath,
            ref SHQUERYRBINFO info);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern uint GetDriveTypeW([MarshalAs(UnmanagedType.LPWStr)] string rootPath);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetVolumePathNameW(
            [MarshalAs(UnmanagedType.LPWStr)] string path,
            StringBuilder volumePathName,
            uint bufferLength);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetVolumeNameForVolumeMountPointW(
            [MarshalAs(UnmanagedType.LPWStr)] string mountPoint,
            StringBuilder volumeName,
            uint bufferLength);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFileW(
            [MarshalAs(UnmanagedType.LPWStr)] string path,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandle(IntPtr handle, out ByHandleFileInformation info);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("ole32.dll")]
        private static extern int CoInitializeEx(IntPtr reserved, uint apartment);
        [DllImport("ole32.dll")]
        private static extern void CoUninitialize();
        [DllImport("ole32.dll")]
        private static extern void CoTaskMemFree(IntPtr memory);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
        private static extern int RegOpenKeyExW(IntPtr key, string subKey, int options, uint access, out IntPtr result);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
        private static extern int RegQueryValueExW(IntPtr key, string valueName, IntPtr reserved, out uint type, out uint data, ref uint size);
        [DllImport("advapi32.dll")]
        private static extern int RegCloseKey(IntPtr key);

        private static void Check(int result, string operation)
        {
            if (result < 0) throw new COMException(operation + String.Format(" failed with HRESULT 0x{0:X8}.", result), result);
        }

        private static bool SamePath(string left, string right)
        {
            if (left == null || right == null) return false;
            return String.Equals(left.TrimEnd('\\'), right.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
        }

        /** The registry key uses the full brace-delimited GUID, e.g. {1f5e...}. */
        private static string RequireVolumeGuid(string mount)
        {
            StringBuilder volumeName = new StringBuilder(1024);
            if (!GetVolumeNameForVolumeMountPointW(mount, volumeName, (uint)volumeName.Capacity))
                throw new InvalidOperationException("Could not resolve this mount point to a volume GUID; no delete was scheduled.");
            string text = volumeName.ToString();
            int open = text.IndexOf('{');
            int close = text.IndexOf('}');
            if (open < 0 || close <= open || close != text.LastIndexOf('}'))
                throw new InvalidOperationException("Windows returned an unrecognized volume GUID format; no delete was scheduled.");
            return text.Substring(open, close - open + 1);
        }

        private static PolicyState ReadPolicyValue(IntPtr hive, string subKey, string valueName)
        {
            IntPtr opened = IntPtr.Zero;
            int result = RegOpenKeyExW(hive, subKey, 0, KeyRead, out opened);
            if (result == ErrorFileNotFound) return PolicyState.Enabled;
            if (result != 0) return PolicyState.Unverified;
            try
            {
                uint type;
                uint size = 4;
                uint value = 0;
                result = RegQueryValueExW(opened, valueName, IntPtr.Zero, out type, out value, ref size);
                if (result == ErrorFileNotFound) return PolicyState.Enabled;
                if (result != 0 || type != 4 || size != 4) return PolicyState.Unverified;
                if (value == 0) return PolicyState.Enabled;
                if (value == 1) return PolicyState.Disabled;
                return PolicyState.Unverified;
            }
            finally
            {
                RegCloseKey(opened);
            }
        }

        private static PolicyState ReadPerVolumePolicy(string volumeGuid)
        {
            string subKey = "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket\\Volume\\" + volumeGuid;
            return ReadPolicyValue(HKeyCurrentUser, subKey, "NukeOnDelete");
        }

        private static PolicyState ReadGlobalPolicy()
        {
            string subKey = "Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer";
            PolicyState user = ReadPolicyValue(HKeyCurrentUser, subKey, "NoRecycleFiles");
            PolicyState machine = ReadPolicyValue(HKeyLocalMachine, subKey, "NoRecycleFiles");
            if (user == PolicyState.Unverified || machine == PolicyState.Unverified) return PolicyState.Unverified;
            if (user == PolicyState.Disabled || machine == PolicyState.Disabled) return PolicyState.Disabled;
            return PolicyState.Enabled;
        }

        private static PolicyState ReadLegacyGlobalBitBucketPolicy()
        {
            string subKey = "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket";
            return ReadPolicyValue(HKeyCurrentUser, subKey, "NukeOnDelete");
        }

        private static void RequireRecycleEnabled(string volumeGuid)
        {
            PolicyState perVolume = ReadPerVolumePolicy(volumeGuid);
            if (perVolume == PolicyState.Unverified)
                throw new InvalidOperationException("Per-volume Recycle Bin policy could not be verified; no delete was scheduled.");
            if (perVolume == PolicyState.Disabled)
                throw new InvalidOperationException("Windows is configured to bypass the Recycle Bin on this volume; no delete was scheduled.");

            PolicyState global = ReadGlobalPolicy();
            if (global == PolicyState.Unverified)
                throw new InvalidOperationException("Global Recycle Bin policy could not be verified; no delete was scheduled.");
            if (global == PolicyState.Disabled)
                throw new InvalidOperationException("Windows policy disables the Recycle Bin; no delete was scheduled.");

            PolicyState legacy = ReadLegacyGlobalBitBucketPolicy();
            if (legacy == PolicyState.Unverified)
                throw new InvalidOperationException("Legacy BitBucket settings could not be verified; no delete was scheduled.");
            if (legacy == PolicyState.Disabled)
                throw new InvalidOperationException("Legacy settings disable the Recycle Bin; no delete was scheduled.");
        }

        private static void Preflight(string fullPath)
        {
            StringBuilder mountBuilder = new StringBuilder(1024);
            if (!GetVolumePathNameW(fullPath, mountBuilder, (uint)mountBuilder.Capacity))
                throw new InvalidOperationException("Could not resolve the volume mount point for this path; no delete was scheduled.");
            string mount = mountBuilder.ToString();
            if (String.IsNullOrEmpty(mount))
                throw new InvalidOperationException("Windows returned an empty volume mount point; no delete was scheduled.");

            string volumeGuid = RequireVolumeGuid(mount);
            uint driveType = GetDriveTypeW(mount);
            if (driveType == DriveUnknown || driveType == DriveNoRoot || driveType == DriveRemote || driveType == DriveCdrom || driveType == DriveRamdisk)
                throw new InvalidOperationException("This volume type has no verified Windows Recycle Bin; no delete was scheduled.");
            if (driveType != DriveFixed && driveType != DriveRemovable)
                throw new InvalidOperationException("This volume type is not approved for recycle-only cleanup; no delete was scheduled.");

            SHQUERYRBINFO info = new SHQUERYRBINFO();
            info.cbSize = Marshal.SizeOf(typeof(SHQUERYRBINFO));
            Check(SHQueryRecycleBinW(mount, ref info), "Checking Recycle Bin availability");
            RequireRecycleEnabled(volumeGuid);
        }

        /** Opens without following links and rejects every reparse-point attribute. */
        private static string ReadFileIdentity(string path)
        {
            IntPtr handle = CreateFileW(
                path,
                0,
                FileShareAll,
                IntPtr.Zero,
                OpenExisting,
                FileFlagBackupSemantics | FileFlagOpenReparsePoint,
                IntPtr.Zero);
            if (handle == InvalidHandle)
                throw new InvalidOperationException("Windows could not open this item for identity verification; no delete was scheduled.");
            try
            {
                ByHandleFileInformation info;
                if (!GetFileInformationByHandle(handle, out info))
                    throw new InvalidOperationException("Windows could not read this item's file identity; no delete was scheduled.");
                if ((info.FileAttributes & FileAttributeReparsePoint) != 0)
                    throw new InvalidOperationException("This item is a reparse point and is not a cleanup candidate; no delete was scheduled.");
                return String.Format("{0:X8}:{1:X8}{2:X8}", info.VolumeSerialNumber, info.FileIndexHigh, info.FileIndexLow);
            }
            finally
            {
                CloseHandle(handle);
            }
        }

        private static string VerifiedShellPath(string fullPath, object shellItem, string expectedIdentity)
        {
            IShellItem item = shellItem as IShellItem;
            if (item == null) throw new InvalidOperationException("Windows did not return a filesystem Shell item; no delete was scheduled.");
            IntPtr pointer = IntPtr.Zero;
            try
            {
                Check(item.GetDisplayName(SigdnFilePath, out pointer), "Reading the Shell item path");
                string actual = Marshal.PtrToStringUni(pointer);
                if (!SamePath(actual, fullPath))
                    throw new InvalidOperationException("The Shell item path no longer matches the confirmed path; no delete was scheduled.");
                if (!String.Equals(ReadFileIdentity(actual), expectedIdentity, StringComparison.Ordinal))
                    throw new InvalidOperationException("The Shell item no longer matches the verified file identity; no delete was scheduled.");
                return actual;
            }
            finally
            {
                if (pointer != IntPtr.Zero) CoTaskMemFree(pointer);
            }
        }

        public static RecycleResult[] Recycle(string[] paths)
        {
            int initialized = CoInitializeEx(IntPtr.Zero, ApartmentThreaded);
            Check(initialized, "COM initialization");
            try
            {
                RecycleResult[] results = new RecycleResult[paths.Length];
                for (int i = 0; i < paths.Length; i++) results[i] = RecycleOne(paths[i]);
                return results;
            }
            finally
            {
                CoUninitialize();
            }
        }

        private static RecycleResult RecycleOne(string path)
        {
            RecycleResult result = new RecycleResult { Path = path, Success = false, Error = null };
            IFileOperation operation = null;
            object item = null;
            RecycleGuard sink = new RecycleGuard();
            try
            {
                string fullPath = Path.GetFullPath(path);
                Preflight(fullPath);
                string identity = ReadFileIdentity(fullPath);

                Guid interfaceId = ShellItemGuid;
                Check(SHCreateItemFromParsingName(fullPath, IntPtr.Zero, ref interfaceId, out item), "Creating the Shell item");
                VerifiedShellPath(fullPath, item, identity);

                operation = (IFileOperation)new FileOperationComObject();
                uint flags = RecycleOnDelete | EarlyFailure | AddUndoRecord | NoErrorUi | NoConfirmation | Silent;
                Check(operation.SetOperationFlags(flags), "Setting recycle-only operation flags");
                Check(operation.DeleteItem(item, sink), "Queueing the recycle operation");
                Check(operation.PerformOperations(), "Performing the recycle operation");
                bool aborted;
                Check(operation.GetAnyOperationsAborted(out aborted), "Checking recycle cancellation");
                if (aborted) throw new OperationCanceledException("Windows cancelled the recycle operation.");
                if (!sink.SawPre || !sink.SawPost || !sink.SawFinish || sink.DeleteCallbacks != 1 || sink.Failure != null)
                    throw new InvalidOperationException(sink.Failure ?? "Windows did not complete the Recycle Bin operation with all required confirmations.");

                // Success requires all of the above evidence. PostDeleteItem is
                // confirmation of destination, not a rollback mechanism.
                result.Success = true;
            }
            catch (Exception error)
            {
                result.Error = sink.Failure ?? error.Message;
            }
            finally
            {
                GC.KeepAlive(sink);
                if (operation != null) Marshal.FinalReleaseComObject(operation);
                if (item != null) Marshal.FinalReleaseComObject(item);
            }
            return result;
        }
    }
}
