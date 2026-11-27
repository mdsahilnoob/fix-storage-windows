using System;
using System.Runtime.InteropServices;

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

    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.None)]
    public sealed class RecycleGuard : IFileOperationProgressSink
    {
        public const uint RecycleIfPossible = 0x80;
        public const int Abort = unchecked((int)0x80004004);
        public bool SawDelete;
        public string Failure;

        public int StartOperations() { return 0; }
        public int FinishOperations(int result)
        {
            if (result < 0 && Failure == null) Failure = String.Format("Shell operation failed with HRESULT 0x{0:X8}.", result);
            return 0;
        }
        public int PreRenameItem(uint flags, IntPtr item, string newName) { return 0; }
        public int PostRenameItem(uint flags, IntPtr item, string newName, int result, IntPtr newlyCreated) { return 0; }
        public int PreMoveItem(uint flags, IntPtr item, IntPtr destination, string newName) { return 0; }
        public int PostMoveItem(uint flags, IntPtr item, IntPtr destination, string newName, int result, IntPtr newlyCreated) { return 0; }
        public int PreCopyItem(uint flags, IntPtr item, IntPtr destination, string newName) { return 0; }
        public int PostCopyItem(uint flags, IntPtr item, IntPtr destination, string newName, int result, IntPtr newlyCreated) { return 0; }

        public int PreDeleteItem(uint flags, IntPtr item)
        {
            if ((flags & RecycleIfPossible) != 0) return 0;
            Failure = "Shell did not mark this operation as recycle-if-possible before deletion.";
            return Abort;
        }

        public int PostDeleteItem(uint flags, IntPtr item, int result, IntPtr newlyCreated)
        {
            SawDelete = true;
            if (result < 0)
            {
                Failure = String.Format("Shell delete failed with HRESULT 0x{0:X8}.", result);
                return Abort;
            }
            // Microsoft documents psiNewlyCreated as non-null only when the
            // deleted item is now in the Recycle Bin. Full deletion supplies NULL.
            if ((flags & RecycleIfPossible) == 0 || newlyCreated == IntPtr.Zero)
            {
                Failure = "Shell did not confirm a Recycle Bin destination. Manual inspection is required; no fallback was attempted.";
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

    public static class NativeRecycle
    {
        private const uint RecycleOnDelete = 0x00080000;
        private const uint EarlyFailure = 0x00100000;
        private const uint AddUndoRecord = 0x20000000;
        private const uint NoErrorUi = 0x00000400;
        private const uint NoConfirmation = 0x00000010;
        private const uint Silent = 0x00000004;
        private const uint ApartmentThreaded = 0x2;
        private static readonly Guid ShellItemGuid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        private static extern int SHCreateItemFromParsingName(
            [MarshalAs(UnmanagedType.LPWStr)] string path,
            IntPtr bindContext,
            ref Guid interfaceId,
            [MarshalAs(UnmanagedType.Interface)] out object shellItem);

        [DllImport("ole32.dll")]
        private static extern int CoInitializeEx(IntPtr reserved, uint apartment);
        [DllImport("ole32.dll")]
        private static extern void CoUninitialize();

        private static void Check(int result, string operation)
        {
            if (result < 0) throw new COMException(operation + String.Format(" failed with HRESULT 0x{0:X8}.", result), result);
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
                string fullPath = System.IO.Path.GetFullPath(path);
                Guid interfaceId = ShellItemGuid;
                Check(SHCreateItemFromParsingName(fullPath, IntPtr.Zero, ref interfaceId, out item), "Creating the Shell item");
                operation = (IFileOperation)new FileOperationComObject();
                uint flags = RecycleOnDelete | EarlyFailure | AddUndoRecord | NoErrorUi | NoConfirmation | Silent;
                Check(operation.SetOperationFlags(flags), "Setting recycle-only operation flags");
                Check(operation.DeleteItem(item, sink), "Queueing the recycle operation");
                Check(operation.PerformOperations(), "Performing the recycle operation");
                bool aborted;
                Check(operation.GetAnyOperationsAborted(out aborted), "Checking recycle cancellation");
                if (aborted) throw new OperationCanceledException("Windows cancelled the recycle operation.");
                if (!sink.SawDelete || sink.Failure != null)
                    throw new InvalidOperationException(sink.Failure ?? "Shell did not confirm a Recycle Bin destination.");

                // Success is based on PostDeleteItem's non-null Recycle Bin item,
                // never merely on the disappearance of the source path.
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
