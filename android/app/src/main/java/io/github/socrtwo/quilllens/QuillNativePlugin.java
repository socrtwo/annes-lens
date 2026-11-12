package io.github.socrtwo.quilllens;

import android.app.Activity;
import android.app.WallpaperManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.provider.MediaStore;
import android.provider.Settings;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.SharedPreferences;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;
import android.os.Build;
import android.os.PersistableBundle;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.MimeTypeMap;
import android.webkit.WebView;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import androidx.core.content.IntentCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native file plumbing for Anne's Lens on Android.
 *
 * JS contract (all binary payloads are base64 strings without line breaks):
 * <ul>
 *   <li>openDocument({mimeTypes: string[], multiple?: boolean}) -> {uri, name, mime, data} | {files: [...]} | {canceled: true}</li>
 *   <li>saveAs({name, mime, data}) -> {uri, name} | {canceled: true}</li>
 *   <li>writeUri({uri, data}) -> {ok: true}</li>
 *   <li>readUri({uri}) -> {uri, name, mime, data}</li>
 *   <li>print({jobName}) -> void</li>
 *   <li>share({name, mime, data, title, subject?, text?, to?}) -> void</li>
 *   <li>getLaunchFile() -> {uri?, name, mime, data, files?: [...]} | {} (consumed once; "Share" of several pictures lists them all)</li>
 *   <li>keepAwake({on: boolean}) -> void</li>
 *   <li>event "fileOpened" -> same payload as getLaunchFile, for files opened while running</li>
 *   <li>readClipboard() -> {text} / writeClipboard({text, sensitive})</li>
 *   <li>openInApp({packageName, name, mime, data}) -> {opened: true} | {opened: false, reason: "not-installed"}:
 *       hands a picture to a sibling Anne's Office app (Anne's Pen, Anne's Stage, Anne's Folio, Anne's Press) with ACTION_VIEW</li>
 *   <li>renameDocument({uri, name}) -> {uri, name}; deleteDocument({uri}) -> {ok: true} (Storage Access Framework)</li>
 *   <li>pickFolder({title}) -> {uri, name} | {canceled: true}: ACTION_OPEN_DOCUMENT_TREE with a persisted permission</li>
 *   <li>listFolder({uri}) -> {uri, name, entries: [{uri, name, size, mtime}]}: the pictures in a picked folder</li>
 *   <li>createInFolder({dirUri, name, mime, data}) -> {uri, name}: a new file in a picked folder (replaces a same-named file)</li>
 *   <li>request({url, method, headers, body, timeoutMs}) -> {status, headers, data}: an HTTP request for AI services (body and answer as base64)</li>
 *   <li>setWallpaper({data, which}) -> {ok}: the PNG as the home ('home'), lock ('lock') or both wallpapers</li>
 *   <li>attachData({name, mime, data}) -> {ok}: ACTION_ATTACH_DATA (Set as contact photo and similar)</li>
 *   <li>openCastSettings() -> {ok}: the system Cast / wireless display picker</li>
 *   <li>copyFileToClipboard({name, mime, data}) -> {ok}: a content URI on the clipboard for file managers that paste files</li>
 *   <li>capturePhoto() -> {name, mime, data} | {canceled: true}: ACTION_IMAGE_CAPTURE through the camera app</li>
 *   <li>createSubfolder({dirUri, name}) -> {uri, name}: a child folder of a picked folder (existing one reused)</li>
 *   <li>openDefaultApps() -> {ok}: the system Default apps settings (file associations)</li>
 * </ul>
 */
@CapacitorPlugin(name = "QuillNative")
public class QuillNativePlugin extends Plugin {

    private static final String TAG = "QuillNative";
    private static final String EVENT_FILE_OPENED = "fileOpened";
    private static final String SHARE_DIR = "shared";
    private static final long SHARE_FILE_MAX_AGE_MS = 24L * 60L * 60L * 1000L;

    /** Single background thread for file I/O so large documents never block the UI or the plugin queue. */
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    // Network requests run apart from file work (a long AI request must not hold up opening files), each with an id the
    // page can cancel by (Stop AI).
    private final ExecutorService net = Executors.newCachedThreadPool();
    private final java.util.Map<String, HttpURLConnection> requests = new java.util.concurrent.ConcurrentHashMap<>();
    /** Large payloads waiting for an activity result, kept out of the call's saved state. */
    private static final java.util.Map<String, String> pendingData = new java.util.concurrent.ConcurrentHashMap<>();
    /** Largest file read into memory (bytes); bigger files are refused instead of crashing. */
    private static final long MAX_READ_BYTES = 64L * 1024L * 1024L;

    private final Object launchLock = new Object();
    private boolean launchFileConsumed = false;

    @Override
    protected void handleOnDestroy() {
        io.shutdown();
        super.handleOnDestroy();
    }

    // ---------------------------------------------------------------------------------------------
    // Clipboard
    // ---------------------------------------------------------------------------------------------

    // Secure storage for small secrets (AI service keys): EncryptedSharedPreferences backed by the Android Keystore.
    private SharedPreferences secrets() throws Exception {
        MasterKey key = new MasterKey.Builder(getContext()).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build();
        return EncryptedSharedPreferences.create(getContext(), "secrets", key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV, EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
    }

    @PluginMethod
    public void secretInfo(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", true);
        ret.put("backend", "android-keystore");
        call.resolve(ret);
    }

    @PluginMethod
    public void secretGet(PluginCall call) {
        String name = call.getString("name");
        if (name == null) { call.reject("name is required"); return; }
        try {
            String v = secrets().getString(name, null);
            JSObject ret = new JSObject();
            ret.put("value", v == null ? JSObject.NULL : v);
            call.resolve(ret);
        } catch (Throwable e) {
            call.reject("Could not read the secret: " + e.getMessage(), asException(e));
        }
    }

    @PluginMethod
    public void secretSet(PluginCall call) {
        String name = call.getString("name");
        String value = call.getString("value");
        if (name == null || value == null) { call.reject("name and value are required"); return; }
        try {
            secrets().edit().putString(name, value).apply();
            call.resolve(new JSObject());
        } catch (Throwable e) {
            call.reject("Could not store the secret: " + e.getMessage(), asException(e));
        }
    }

    @PluginMethod
    public void secretDelete(PluginCall call) {
        String name = call.getString("name");
        if (name == null) { call.reject("name is required"); return; }
        try {
            secrets().edit().remove(name).apply();
            call.resolve(new JSObject());
        } catch (Throwable e) {
            call.reject("Could not delete the secret: " + e.getMessage(), asException(e));
        }
    }

    @PluginMethod
    public void readClipboard(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject ret = new JSObject();
            try {
                ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
                ClipData clip = cm != null ? cm.getPrimaryClip() : null;
                if (clip != null && clip.getItemCount() > 0) {
                    CharSequence text = clip.getItemAt(0).coerceToText(getContext());
                    ret.put("text", text != null ? text.toString() : JSObject.NULL);
                } else {
                    ret.put("text", JSObject.NULL);
                }
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("Could not read the clipboard: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void writeClipboard(PluginCall call) {
        final String text = call.getString("text", "");
        final boolean sensitive = Boolean.TRUE.equals(call.getBoolean("sensitive", false));
        getActivity().runOnUiThread(() -> {
            try {
                ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm == null) {
                    call.reject("No clipboard service");
                    return;
                }
                if ((text == null || text.isEmpty()) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    cm.clearPrimaryClip();
                } else {
                    ClipData clip = ClipData.newPlainText("Anne's Lens", text);
                    if (sensitive && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        PersistableBundle extras = new PersistableBundle();
                        extras.putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true);
                        clip.getDescription().setExtras(extras);
                    }
                    cm.setPrimaryClip(clip);
                }
                call.resolve();
            } catch (Throwable e) {
                call.reject("Could not write the clipboard: " + e.getMessage(), asException(e));
            }
        });
    }

    // ---------------------------------------------------------------------------------------------
    // Open / save via the Storage Access Framework
    // ---------------------------------------------------------------------------------------------

    @PluginMethod
    public void openDocument(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        String[] mimeTypes = toStringArray(call.getArray("mimeTypes"));
        if (mimeTypes.length > 0) {
            intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes);
        }
        if (Boolean.TRUE.equals(call.getBoolean("multiple", false))) {
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }
        try {
            startActivityForResult(call, intent, "openResult");
        } catch (ActivityNotFoundException e) {
            call.reject("No file picker is available on this device", e);
        }
    }

    @ActivityCallback
    private void openResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        final List<Uri> uris = resultUris(result);
        if (uris.isEmpty()) {
            resolveCanceled(call);
            return;
        }
        for (Uri u : uris) {
            takePersistablePermission(u);
        }
        io.execute(() -> {
            try {
                if (uris.size() == 1) {
                    call.resolve(readDocument(uris.get(0), null));
                    return;
                }
                JSObject ret = new JSObject();
                JSArray files = new JSArray();
                for (Uri u : uris) {
                    files.put(readDocument(u, null));
                }
                ret.put("files", files);
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("Could not read document: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void saveAs(PluginCall call) {
        String name = call.getString("name", "Untitled");
        String mime = call.getString("mime", "application/octet-stream");
        if (call.getString("data") == null) {
            call.reject("saveAs requires 'data'");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
        intent.putExtra(Intent.EXTRA_TITLE, name);
        // Capacitor parcels the call's data into onSaveInstanceState while the picker is up;
        // a large base64 document there exceeds the 1 MB binder limit (TransactionTooLargeException).
        pendingData.put(call.getCallbackId(), call.getString("data"));
        call.getData().remove("data");
        try {
            startActivityForResult(call, intent, "saveResult");
        } catch (ActivityNotFoundException e) {
            pendingData.remove(call.getCallbackId());
            call.reject("No file picker is available on this device", e);
        }
    }

    @ActivityCallback
    private void saveResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        final Uri uri = resultUri(result);
        final String data = pendingData.remove(call.getCallbackId());
        if (uri == null) {
            resolveCanceled(call);
            return;
        }
        if (data == null) {
            // The app process was recreated while the picker was open.
            call.reject("The document was not kept while the file picker was open. Please save again.");
            return;
        }
        io.execute(() -> {
            try {
                writeBytes(uri, decodeBase64(data));
                takePersistablePermission(uri);
                String name = queryDisplayName(uri);
                JSObject ret = new JSObject();
                ret.put("uri", uri.toString());
                ret.put("name", name != null ? name : call.getString("name", ""));
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("Could not save document: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void writeUri(PluginCall call) {
        final String uriString = call.getString("uri");
        final String data = call.getString("data");
        if (uriString == null || uriString.isEmpty() || data == null) {
            call.reject("writeUri requires 'uri' and 'data'");
            return;
        }
        io.execute(() -> {
            try {
                writeBytes(Uri.parse(uriString), decodeBase64(data));
                JSObject ret = new JSObject();
                ret.put("ok", true);
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("Could not write document: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void readUri(PluginCall call) {
        final String uriString = call.getString("uri");
        if (uriString == null || uriString.isEmpty()) {
            call.reject("readUri requires 'uri'");
            return;
        }
        io.execute(() -> {
            try {
                call.resolve(readDocument(Uri.parse(uriString), null));
            } catch (Throwable e) {
                call.reject("Could not read document: " + e.getMessage(), asException(e));
            }
        });
    }

    // ---------------------------------------------------------------------------------------------
    // File operations (Storage Access Framework)
    // ---------------------------------------------------------------------------------------------

    private static final String[] PICTURE_EXTENSIONS = {
        "jpg", "jpeg", "jpe", "jfif", "png", "apng", "gif", "webp", "avif", "heic", "heif", "hif", "bmp", "dib", "ico", "cur", "tif", "tiff",
        "svg", "svgz", "jxl", "psd", "psb", "tga", "pnm", "ppm", "pgm", "pbm", "pam", "pfm", "qoi", "pcx", "dcx", "xpm", "xbm", "wbmp", "icns", "dds", "hdr",
        "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "raf", "orf", "rw2", "rwl", "pef", "dng", "3fr", "fff", "iiq", "x3f", "srw", "mrw", "erf", "mef", "mos", "kdc", "dcr",
        "pdf", "djvu", "djv", "pct", "pict", "ras", "sun", "im1", "im8", "im24", "im32", "sgi", "rgb", "rgba", "bw", "urt", "pi1", "pi2", "pi3", "pc1", "pc2", "pc3", "neo", "spu", "koa", "kla", "art", "aas", "ximg", "msp", "fpx", "fli", "flc", "flx", "clp", "jbg", "jbig", "bie", "jb2", "jbig2", "psp", "pspimage", "tub", "icl", "cdr", "cpt", "iff", "ilbm", "lbm", "ham", "ham8", "mac", "pntg", "pnt", "pcd", "exr", "jp2", "jpx", "jpf", "jph", "j2k", "j2c", "jpc", "jhc", "wmf", "emf", "wmz", "emz",
        "dcm", "dicom", "fits", "fit", "fts",
        "mp4", "m4v", "mov", "qt", "3gp", "3g2", "webm", "mkv", "ogv", "avi", "mp3", "mp2", "m4a", "m4b", "aac", "flac", "wav", "wave", "ogg", "oga", "opus", "spx", "aif", "aiff", "aifc", "mka", "weba"
    };

    private static boolean isPictureName(String name) {
        if (name == null) {
            return false;
        }
        int dot = name.lastIndexOf('.');
        if (dot < 0) {
            return false;
        }
        String ext = name.substring(dot + 1).toLowerCase(Locale.ROOT);
        for (String e : PICTURE_EXTENSIONS) {
            if (e.equals(ext)) {
                return true;
            }
        }
        return false;
    }

    @PluginMethod
    public void renameDocument(PluginCall call) {
        final String uriString = call.getString("uri");
        final String name = call.getString("name");
        if (uriString == null || uriString.isEmpty() || name == null || name.trim().isEmpty()) {
            call.reject("renameDocument requires 'uri' and 'name'");
            return;
        }
        io.execute(() -> {
            try {
                Uri uri = Uri.parse(uriString);
                Uri renamed = DocumentsContract.renameDocument(getContext().getContentResolver(), uri, name.trim());
                if (renamed == null) {
                    throw new IOException("The storage provider refused to rename the file");
                }
                takePersistablePermission(renamed);
                String newName = queryDisplayName(renamed);
                JSObject ret = new JSObject();
                ret.put("uri", renamed.toString());
                ret.put("name", newName != null ? newName : name.trim());
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("Could not rename: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void deleteDocument(PluginCall call) {
        final String uriString = call.getString("uri");
        if (uriString == null || uriString.isEmpty()) {
            call.reject("deleteDocument requires 'uri'");
            return;
        }
        io.execute(() -> {
            try {
                boolean ok = DocumentsContract.deleteDocument(getContext().getContentResolver(), Uri.parse(uriString));
                if (!ok) {
                    throw new IOException("The storage provider refused to delete the file");
                }
                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("trashed", false);
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("Could not delete: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        try {
            startActivityForResult(call, intent, "pickFolderResult");
        } catch (ActivityNotFoundException e) {
            call.reject("No folder picker is available on this device", e);
        }
    }

    @ActivityCallback
    private void pickFolderResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        Uri tree = resultUri(result);
        if (tree == null) {
            resolveCanceled(call);
            return;
        }
        takePersistablePermission(tree);
        JSObject ret = new JSObject();
        ret.put("uri", tree.toString());
        String name = null;
        try {
            Uri docUri = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
            name = queryDisplayName(docUri);
        } catch (Exception e) {
            Log.w(TAG, "Could not query the folder name", e);
        }
        if (name == null || name.isEmpty()) {
            String id = DocumentsContract.getTreeDocumentId(tree);
            int colon = id.lastIndexOf(':');
            int slash = id.lastIndexOf('/');
            name = id.substring(Math.max(colon, slash) + 1);
            if (name.isEmpty()) {
                name = "Folder";
            }
        }
        ret.put("name", name);
        call.resolve(ret);
    }

    @PluginMethod
    public void listFolder(PluginCall call) {
        final String uriString = call.getString("uri");
        final boolean all = Boolean.TRUE.equals(call.getBoolean("all", Boolean.FALSE)); // Show All Files
        if (uriString == null || uriString.isEmpty()) {
            call.reject("listFolder requires 'uri'");
            return;
        }
        io.execute(() -> {
            try {
                Uri tree = Uri.parse(uriString);
                ContentResolver resolver = getContext().getContentResolver();
                // A picked tree, or a folder inside it (Next / Previous Folder hand those back).
                String treeId = folderDocumentId(tree);
                Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, treeId);
                JSArray entries = new JSArray();
                String[] columns = {
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE,
                    DocumentsContract.Document.COLUMN_SIZE,
                    DocumentsContract.Document.COLUMN_LAST_MODIFIED
                };
                try (Cursor cursor = resolver.query(children, columns, null, null, null)) {
                    while (cursor != null && cursor.moveToNext()) {
                        String id = cursor.getString(0);
                        String name = cursor.getString(1);
                        String mime = cursor.isNull(2) ? null : cursor.getString(2);
                        if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime) || name == null || name.startsWith(".")) {
                            continue;
                        }
                        if (!all && !isPictureName(name) && !(mime != null && mime.startsWith("image/"))) {
                            continue;
                        }
                        JSObject e = new JSObject();
                        e.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString());
                        e.put("name", name);
                        if (!cursor.isNull(3)) {
                            e.put("size", cursor.getLong(3));
                        }
                        if (!cursor.isNull(4)) {
                            e.put("mtime", cursor.getLong(4));
                        }
                        entries.put(e);
                    }
                }
                String folderName = queryDisplayName(DocumentsContract.buildDocumentUriUsingTree(tree, treeId));
                JSObject ret = new JSObject();
                ret.put("uri", uriString);
                ret.put("name", folderName != null ? folderName : "Folder");
                ret.put("entries", entries);
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("Could not list the folder: " + e.getMessage(), asException(e));
            }
        });
    }

    /** The document id of a tree URI's root, or of a folder document inside a tree. */
    private String folderDocumentId(Uri uri) {
        if (DocumentsContract.isDocumentUri(getContext(), uri)) {
            return DocumentsContract.getDocumentId(uri);
        }
        return DocumentsContract.getTreeDocumentId(uri);
    }

    /** The folders directly inside a picked tree or a folder in it, in name order, as folder document URIs. */
    @PluginMethod
    public void listSubfolders(PluginCall call) {
        final String uriString = call.getString("uri");
        if (uriString == null || uriString.isEmpty()) {
            call.reject("listSubfolders requires 'uri'");
            return;
        }
        io.execute(() -> {
            try {
                Uri tree = Uri.parse(uriString);
                ContentResolver resolver = getContext().getContentResolver();
                Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, folderDocumentId(tree));
                String[] columns = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE };
                java.util.List<String[]> found = new java.util.ArrayList<>();
                try (Cursor cursor = resolver.query(children, columns, null, null, null)) {
                    while (cursor != null && cursor.moveToNext()) {
                        String id = cursor.getString(0);
                        String name = cursor.getString(1);
                        String mime = cursor.isNull(2) ? null : cursor.getString(2);
                        if (name == null || name.startsWith(".") || !DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                            continue;
                        }
                        found.add(new String[] { DocumentsContract.buildDocumentUriUsingTree(tree, id).toString(), name });
                    }
                }
                java.text.Collator collator = java.text.Collator.getInstance();
                collator.setStrength(java.text.Collator.SECONDARY);
                found.sort((a, b) -> collator.compare(a[1], b[1]));
                JSArray folders = new JSArray();
                for (String[] f : found) {
                    JSObject o = new JSObject();
                    o.put("uri", f[0]);
                    o.put("name", f[1]);
                    folders.put(o);
                }
                JSObject ret = new JSObject();
                ret.put("folders", folders);
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("Could not list the subfolders: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void createInFolder(PluginCall call) {
        final String dirUri = call.getString("dirUri");
        final String name = call.getString("name");
        final String mime = call.getString("mime", "application/octet-stream");
        final String data = call.getString("data");
        // "rename": never replace a file of the same name (the provider then appends " (1)"); otherwise replace it.
        final boolean keepExisting = "rename".equals(call.getString("ifExists", "overwrite"));
        if (dirUri == null || dirUri.isEmpty() || name == null || name.trim().isEmpty() || data == null) {
            call.reject("createInFolder requires 'dirUri', 'name' and 'data'");
            return;
        }
        io.execute(() -> {
            try {
                Uri tree = Uri.parse(dirUri);
                ContentResolver resolver = getContext().getContentResolver();
                // The picked tree's root, or a folder inside it (createSubfolder and listSubfolders hand those back).
                String folderId = folderDocumentId(tree);
                Uri parent = DocumentsContract.buildDocumentUriUsingTree(tree, folderId);
                if (!keepExisting) {
                    // Replace a file of the same name rather than letting the provider append " (1)".
                    Uri existing = findChild(resolver, tree, folderId, name.trim());
                    if (existing != null) {
                        DocumentsContract.deleteDocument(resolver, existing);
                    }
                }
                Uri created = DocumentsContract.createDocument(resolver, parent, mime == null || mime.isEmpty() ? "application/octet-stream" : mime, name.trim());
                if (created == null) {
                    throw new IOException("The storage provider refused to create the file");
                }
                writeBytes(created, decodeBase64(data));
                String newName = queryDisplayName(created);
                JSObject ret = new JSObject();
                ret.put("uri", created.toString());
                ret.put("name", newName != null ? newName : name.trim());
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("Could not create the file: " + e.getMessage(), asException(e));
            }
        });
    }

    private static Uri findChild(ContentResolver resolver, Uri tree, String folderId, String name) {
        try {
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, folderId);
            String[] columns = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME };
            try (Cursor cursor = resolver.query(children, columns, null, null, null)) {
                while (cursor != null && cursor.moveToNext()) {
                    if (name.equals(cursor.getString(1))) {
                        return DocumentsContract.buildDocumentUriUsingTree(tree, cursor.getString(0));
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not look for " + name, e);
        }
        return null;
    }

    // ---------------------------------------------------------------------------------------------
    // Print / share / screen
    // ---------------------------------------------------------------------------------------------

    @PluginMethod
    public void print(PluginCall call) {
        final String jobName = call.getString("jobName", "Anne's Lens document");
        final Activity activity = getActivity();
        if (activity == null) {
            call.reject("Printing is not available right now");
            return;
        }
        activity.runOnUiThread(() -> {
            try {
                PrintManager printManager = (PrintManager) activity.getSystemService(Context.PRINT_SERVICE);
                WebView webView = getBridge().getWebView();
                if (printManager == null || webView == null) {
                    call.reject("Printing is not available on this device");
                    return;
                }
                PrintDocumentAdapter adapter = webView.createPrintDocumentAdapter(jobName);
                printManager.print(jobName, adapter, new PrintAttributes.Builder().build());
                call.resolve();
            } catch (Throwable e) {
                call.reject("Could not start printing: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void share(PluginCall call) {
        final String name = sanitizeFileName(call.getString("name", "document"));
        final String mime = call.getString("mime", "application/octet-stream");
        final String data = call.getString("data");
        final String title = call.getString("title", name);
        final String subject = call.getString("subject");
        final String text = call.getString("text");
        final String to = call.getString("to");
        if (data == null) {
            call.reject("share requires 'data'");
            return;
        }
        io.execute(() -> {
            try {
                Context context = getContext();
                File dir = new File(context.getCacheDir(), SHARE_DIR);
                if (!dir.isDirectory() && !dir.mkdirs()) {
                    throw new IOException("Cannot create " + dir.getAbsolutePath());
                }
                pruneOldShares(dir);
                File file = new File(dir, name);
                try (FileOutputStream out = new FileOutputStream(file)) {
                    out.write(decodeBase64(data));
                }
                Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);

                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                send.putExtra(Intent.EXTRA_STREAM, uri);
                send.putExtra(Intent.EXTRA_TITLE, name);
                if (subject != null) send.putExtra(Intent.EXTRA_SUBJECT, subject);
                if (text != null) send.putExtra(Intent.EXTRA_TEXT, text);
                if (to != null) send.putExtra(Intent.EXTRA_EMAIL, new String[] { to });
                send.setClipData(ClipData.newRawUri(name, uri));
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

                final Intent chooser = Intent.createChooser(send, title);
                chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

                final Activity activity = getActivity();
                if (activity == null) {
                    call.reject("Sharing is not available right now");
                    return;
                }
                activity.runOnUiThread(() -> {
                    try {
                        activity.startActivity(chooser);
                        call.resolve();
                    } catch (ActivityNotFoundException e) {
                        call.reject("No app is available to share with", e);
                    }
                });
            } catch (Throwable e) {
                call.reject("Could not share document: " + e.getMessage(), asException(e));
            }
        });
    }

    /** HTTP request for AI services: no WebView cross-origin limits. Body and answer travel as base64. */
    @PluginMethod
    public void request(PluginCall call) {
        final String url = call.getString("url", "");
        final String method = "POST".equalsIgnoreCase(call.getString("method", "GET")) ? "POST" : "GET";
        final JSObject headers = call.getObject("headers", new JSObject());
        final String body = call.getString("body");
        final int timeout = (int) Math.min(Math.max(call.getInt("timeoutMs", 180000), 1000), 600000);
        final String id = call.getString("id");
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            call.reject("Only http(s) addresses can be requested");
            return;
        }
        net.execute(() -> {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(url).openConnection();
                if (id != null) {
                    requests.put(id, c);
                }
                c.setRequestMethod(method);
                c.setConnectTimeout(timeout);
                c.setReadTimeout(timeout);
                c.setInstanceFollowRedirects(true);
                java.util.Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    String v = headers.optString(k, null);
                    if (v != null) {
                        c.setRequestProperty(k, v);
                    }
                }
                if (body != null && "POST".equals(method)) {
                    byte[] bytes = decodeBase64(body);
                    c.setDoOutput(true);
                    c.setFixedLengthStreamingMode(bytes.length);
                    try (OutputStream out = c.getOutputStream()) {
                        out.write(bytes);
                    }
                }
                int status = c.getResponseCode();
                InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                if (in != null) {
                    byte[] chunk = new byte[65536];
                    int n;
                    long total = 0;
                    while ((n = in.read(chunk)) > 0) {
                        total += n;
                        if (total > 256L * 1024 * 1024) {
                            throw new IOException("The answer is larger than 256 MB");
                        }
                        buf.write(chunk, 0, n);
                    }
                    in.close();
                }
                JSObject outHeaders = new JSObject();
                for (java.util.Map.Entry<String, java.util.List<String>> e : c.getHeaderFields().entrySet()) {
                    if (e.getKey() != null && e.getValue() != null && !e.getValue().isEmpty()) {
                        outHeaders.put(e.getKey().toLowerCase(java.util.Locale.ROOT), e.getValue().get(e.getValue().size() - 1));
                    }
                }
                JSObject result = new JSObject();
                result.put("status", status);
                result.put("headers", outHeaders);
                result.put("data", Base64.encodeToString(buf.toByteArray(), Base64.NO_WRAP));
                call.resolve(result);
            } catch (Throwable e) {
                call.reject(id != null && !requests.containsKey(id) ? "Stopped" : "Could not reach the service: " + e.getMessage(), asException(e));
            } finally {
                if (id != null) {
                    requests.remove(id);
                }
                if (c != null) {
                    c.disconnect();
                }
            }
        });
    }

    /** Stops a request started with an id (Stop AI): its connection is closed, so the reading thread ends at once. */
    @PluginMethod
    public void cancelRequest(PluginCall call) {
        String id = call.getString("id");
        HttpURLConnection c = id == null ? null : requests.remove(id);
        if (c != null) {
            net.execute(c::disconnect);
        }
        JSObject ret = new JSObject();
        ret.put("cancelled", c != null);
        call.resolve(ret);
    }

    // Platform-bound file commands --------------------------------------------------------------

    private File sharedFile(String name, byte[] bytes) throws IOException {
        Context context = getContext();
        File dir = new File(context.getCacheDir(), SHARE_DIR);
        if (!dir.isDirectory() && !dir.mkdirs()) {
            throw new IOException("Cannot create " + dir.getAbsolutePath());
        }
        pruneOldShares(dir);
        File file = new File(dir, sanitizeFileName(name));
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(bytes);
        }
        return file;
    }

    private Uri providerUri(File file) {
        Context context = getContext();
        return FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
    }

    /** Sets the picture as the home, lock or both wallpapers (the web side renders it at the screen size). */
    @PluginMethod
    public void setWallpaper(PluginCall call) {
        final String data = call.getString("data");
        final String which = call.getString("which", "home");
        if (data == null) {
            call.reject("setWallpaper requires 'data'");
            return;
        }
        io.execute(() -> {
            try {
                byte[] bytes = decodeBase64(data);
                Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                if (bmp == null) {
                    throw new IOException("The picture could not be decoded");
                }
                WallpaperManager wm = WallpaperManager.getInstance(getContext());
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    int flags = "lock".equals(which) ? WallpaperManager.FLAG_LOCK : "both".equals(which) ? WallpaperManager.FLAG_SYSTEM | WallpaperManager.FLAG_LOCK : WallpaperManager.FLAG_SYSTEM;
                    wm.setBitmap(bmp, null, true, flags);
                } else {
                    wm.setBitmap(bmp);
                }
                JSObject r = new JSObject();
                r.put("ok", true);
                call.resolve(r);
            } catch (Throwable e) {
                call.reject("Could not set the wallpaper: " + e.getMessage(), asException(e));
            }
        });
    }

    /** ACTION_ATTACH_DATA: the system offers the apps that attach a picture to something (Contacts: Set as contact photo). */
    @PluginMethod
    public void attachData(PluginCall call) {
        final String name = call.getString("name", "picture.png");
        final String mime = call.getString("mime", "image/png");
        final String data = call.getString("data");
        if (data == null) {
            call.reject("attachData requires 'data'");
            return;
        }
        io.execute(() -> {
            try {
                Uri uri = providerUri(sharedFile(name, decodeBase64(data)));
                Intent intent = new Intent(Intent.ACTION_ATTACH_DATA);
                intent.setDataAndType(uri, mime);
                intent.putExtra("mimeType", mime);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                final Intent chooser = Intent.createChooser(intent, "Set as");
                chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                final Activity activity = getActivity();
                if (activity == null) {
                    call.reject("Not available right now");
                    return;
                }
                activity.runOnUiThread(() -> {
                    try {
                        activity.startActivity(chooser);
                        JSObject r = new JSObject();
                        r.put("ok", true);
                        call.resolve(r);
                    } catch (ActivityNotFoundException e) {
                        call.reject("No app can use this picture that way", e);
                    }
                });
            } catch (Throwable e) {
                call.reject("Could not hand the picture over: " + e.getMessage(), asException(e));
            }
        });
    }

    /** Opens the system Cast (wireless display) picker; the app then shows the picture full screen. */
    @PluginMethod
    public void openCastSettings(PluginCall call) {
        final Activity activity = getActivity();
        if (activity == null) {
            call.reject("Not available right now");
            return;
        }
        activity.runOnUiThread(() -> {
            for (String action : new String[] { "android.settings.CAST_SETTINGS", "android.settings.WIFI_DISPLAY_SETTINGS", Settings.ACTION_DISPLAY_SETTINGS }) {
                try {
                    activity.startActivity(new Intent(action));
                    JSObject r = new JSObject();
                    r.put("ok", true);
                    r.put("action", action);
                    call.resolve(r);
                    return;
                } catch (ActivityNotFoundException ignored) {
                    // try the next one
                }
            }
            call.reject("This device has no Cast settings screen");
        });
    }

    /** Puts a content URI on the clipboard: file managers that paste files (and apps that accept pictures) can take it. */
    @PluginMethod
    public void copyFileToClipboard(PluginCall call) {
        final String name = call.getString("name", "picture.png");
        final String mime = call.getString("mime", "image/png");
        final String data = call.getString("data");
        if (data == null) {
            call.reject("copyFileToClipboard requires 'data'");
            return;
        }
        io.execute(() -> {
            try {
                Context context = getContext();
                Uri uri = providerUri(sharedFile(name, decodeBase64(data)));
                ClipData clip = ClipData.newUri(context.getContentResolver(), name, uri);
                final ClipboardManager cm = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
                getActivity().runOnUiThread(() -> {
                    try {
                        cm.setPrimaryClip(clip);
                        JSObject r = new JSObject();
                        r.put("ok", true);
                        r.put("uri", uri.toString());
                        call.resolve(r);
                    } catch (Throwable e) {
                        call.reject("Could not copy the file: " + e.getMessage(), asException(e));
                    }
                });
            } catch (Throwable e) {
                call.reject("Could not copy the file: " + e.getMessage(), asException(e));
            }
        });
    }

    private File pendingCapture;

    /** Takes a picture with the camera app (ACTION_IMAGE_CAPTURE into a cache file). */
    @PluginMethod
    public void capturePhoto(PluginCall call) {
        try {
            Context context = getContext();
            File dir = new File(context.getCacheDir(), SHARE_DIR);
            if (!dir.isDirectory() && !dir.mkdirs()) {
                throw new IOException("Cannot create " + dir.getAbsolutePath());
            }
            pendingCapture = new File(dir, "capture-" + System.currentTimeMillis() + ".jpg");
            Uri uri = providerUri(pendingCapture);
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(MediaStore.EXTRA_OUTPUT, uri);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            startActivityForResult(call, intent, "capturePhotoResult");
        } catch (ActivityNotFoundException e) {
            call.reject("No camera app is available", e);
        } catch (Throwable e) {
            call.reject("Could not start the camera: " + e.getMessage(), asException(e));
        }
    }

    @ActivityCallback
    private void capturePhotoResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        final File file = pendingCapture;
        pendingCapture = null;
        if (result.getResultCode() != Activity.RESULT_OK || file == null || !file.isFile()) {
            JSObject r = new JSObject();
            r.put("canceled", true);
            call.resolve(r);
            return;
        }
        io.execute(() -> {
            try {
                byte[] bytes = java.nio.file.Files.readAllBytes(file.toPath());
                JSObject r = new JSObject();
                r.put("name", file.getName());
                r.put("mime", "image/jpeg");
                r.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                call.resolve(r);
            } catch (Throwable e) {
                call.reject("Could not read the photo: " + e.getMessage(), asException(e));
            }
        });
    }

    /** A child folder of a picked tree folder (reused when one of that name exists). */
    @PluginMethod
    public void createSubfolder(PluginCall call) {
        final String dirUri = call.getString("dirUri");
        final String name = call.getString("name", "").trim();
        if (dirUri == null || name.isEmpty()) {
            call.reject("createSubfolder requires 'dirUri' and 'name'");
            return;
        }
        io.execute(() -> {
            try {
                ContentResolver resolver = getContext().getContentResolver();
                Uri tree = Uri.parse(dirUri);
                Uri parent = DocumentsContract.isDocumentUri(getContext(), tree) ? tree : DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
                Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getDocumentId(parent));
                Uri found = null;
                try (Cursor c = resolver.query(children, new String[] { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE }, null, null, null)) {
                    while (c != null && c.moveToNext()) {
                        if (name.equals(c.getString(1)) && DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(2))) {
                            found = DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(0));
                            break;
                        }
                    }
                }
                if (found == null) {
                    found = DocumentsContract.createDocument(resolver, parent, DocumentsContract.Document.MIME_TYPE_DIR, name);
                }
                if (found == null) {
                    throw new IOException("The folder could not be created");
                }
                JSObject r = new JSObject();
                r.put("uri", found.toString());
                r.put("name", name);
                call.resolve(r);
            } catch (Throwable e) {
                call.reject("Could not create the folder: " + e.getMessage(), asException(e));
            }
        });
    }

    /** The system's Default apps settings, where picture types are associated with apps. */
    @PluginMethod
    public void openDefaultApps(PluginCall call) {
        final Activity activity = getActivity();
        if (activity == null) {
            call.reject("Not available right now");
            return;
        }
        activity.runOnUiThread(() -> {
            try {
                activity.startActivity(new Intent(Build.VERSION.SDK_INT >= Build.VERSION_CODES.N ? Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS : Settings.ACTION_APPLICATION_SETTINGS));
                JSObject r = new JSObject();
                r.put("ok", true);
                call.resolve(r);
            } catch (ActivityNotFoundException e) {
                call.reject("No Default apps screen on this device", e);
            }
        });
    }

    /** Sibling apps that may receive a document; any other package is refused. */
    private static final java.util.Set<String> SIBLING_APPS = new java.util.HashSet<>(java.util.Arrays.asList(
        "io.github.socrtwo.quillpen", "io.github.socrtwo.quillpost", "io.github.socrtwo.quillgrid", "io.github.socrtwo.quillstage",
        "io.github.socrtwo.quillloom", "io.github.socrtwo.quillpress", "io.github.socrtwo.quillfolio", "io.github.socrtwo.quilllens"));

    @PluginMethod
    public void openInApp(PluginCall call) {
        final String pkg = call.getString("packageName", "");
        final String name = sanitizeFileName(call.getString("name", "document"));
        final String mime = call.getString("mime", "application/octet-stream");
        final String data = call.getString("data");
        if (!SIBLING_APPS.contains(pkg)) {
            call.reject("openInApp only opens the Anne's Office apps");
            return;
        }
        if (data == null) {
            call.reject("openInApp requires 'data'");
            return;
        }
        io.execute(() -> {
            try {
                Context context = getContext();
                File dir = new File(context.getCacheDir(), SHARE_DIR);
                if (!dir.isDirectory() && !dir.mkdirs()) {
                    throw new IOException("Cannot create " + dir.getAbsolutePath());
                }
                pruneOldShares(dir);
                File file = new File(dir, name);
                try (FileOutputStream out = new FileOutputStream(file)) {
                    out.write(decodeBase64(data));
                }
                Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
                final Intent view = new Intent(Intent.ACTION_VIEW);
                view.setDataAndType(uri, mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                view.setPackage(pkg);
                view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                final Activity activity = getActivity();
                if (activity == null) {
                    call.reject("The app is not in the foreground");
                    return;
                }
                activity.runOnUiThread(() -> {
                    JSObject ret = new JSObject();
                    try {
                        activity.startActivity(view);
                        ret.put("opened", true);
                    } catch (ActivityNotFoundException e) {
                        ret.put("opened", false);
                        ret.put("reason", "not-installed");
                    }
                    call.resolve(ret);
                });
            } catch (Throwable e) {
                call.reject("Could not open the document: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void keepAwake(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", Boolean.TRUE));
        final Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity not available");
            return;
        }
        activity.runOnUiThread(() -> {
            if (on) {
                activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } else {
                activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
            call.resolve();
        });
    }

    // ---------------------------------------------------------------------------------------------
    // Files handed to us by other apps ("Open with" / "Share to")
    // ---------------------------------------------------------------------------------------------

    @PluginMethod
    public void getLaunchFile(PluginCall call) {
        Intent launchIntent = null;
        synchronized (launchLock) {
            if (!launchFileConsumed) {
                launchFileConsumed = true;
                Activity activity = getActivity();
                launchIntent = activity != null ? activity.getIntent() : null;
            }
        }
        if (launchIntent == null || !isFileIntent(launchIntent)) {
            call.resolve(new JSObject());
            return;
        }
        final Intent intent = launchIntent;
        io.execute(() -> {
            try {
                JSObject file = readIntent(intent);
                call.resolve(file != null ? file : new JSObject());
            } catch (Throwable e) {
                call.reject("Could not read the launch file: " + e.getMessage(), asException(e));
            }
        });
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent == null) {
            return;
        }
        // BridgeActivity replays the launching intent through onNewIntent() right after the bridge
        // starts. That one is delivered through getLaunchFile() instead, so skip it here.
        Activity activity = getActivity();
        if (activity != null && intent == activity.getIntent()) {
            return;
        }
        if (!isFileIntent(intent)) {
            return;
        }
        io.execute(() -> {
            try {
                JSObject file = readIntent(intent);
                if (file != null) {
                    // retainUntilConsumed: delivered later if the web app has not subscribed yet.
                    notifyListeners(EVENT_FILE_OPENED, file, true);
                }
            } catch (Exception e) {
                Log.e(TAG, "Could not read incoming file", e);
            }
        });
    }

    private static boolean isFileIntent(Intent intent) {
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action) || Intent.ACTION_EDIT.equals(action)) {
            return intent.getData() != null; // "Edit with" opens the picture like "Open with"
        }
        if (Intent.ACTION_SEND.equals(action)) {
            return streamExtra(intent) != null || intent.getCharSequenceExtra(Intent.EXTRA_TEXT) != null;
        }
        if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            return !streamExtras(intent).isEmpty();
        }
        return false;
    }

    private JSObject readIntent(Intent intent) throws IOException {
        String action = intent.getAction();
        Uri uri = null;
        if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            List<Uri> uris = streamExtras(intent);
            if (uris.isEmpty()) {
                return null;
            }
            JSArray files = new JSArray();
            JSObject first = null;
            for (Uri u : uris) {
                takePersistablePermission(u);
                JSObject f = readDocument(u, intent.getType());
                if (first == null) {
                    first = f;
                }
                files.put(f);
            }
            // The first file's fields with the whole list beside them, in a copy: putting the list into the first file
            // itself made it contain itself, which could not be turned into JSON (a crash, or nothing opened).
            JSObject ret;
            try {
                ret = new JSObject(first.toString());
            } catch (org.json.JSONException e) {
                ret = new JSObject();
            }
            ret.put("files", files);
            return ret;
        }
        if (Intent.ACTION_VIEW.equals(action) || Intent.ACTION_EDIT.equals(action)) {
            uri = intent.getData();
        } else if (Intent.ACTION_SEND.equals(action)) {
            uri = streamExtra(intent);
            if (uri == null) {
                // Plain text shared without a file: hand it over as a .txt file (opens as text import) (no uri).
                CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
                if (text == null) {
                    return null;
                }
                String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
                String base = subject != null && !subject.trim().isEmpty() ? sanitizeFileName(subject.trim()) : "Shared text";
                JSObject ret = new JSObject();
                ret.put("name", base + ".txt");
                ret.put("mime", "text/plain");
                ret.put("data", Base64.encodeToString(text.toString().getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
                return ret;
            }
        }
        if (uri == null) {
            return null;
        }
        takePersistablePermission(uri);
        return readDocument(uri, intent.getType());
    }

    private static List<Uri> streamExtras(Intent intent) {
        List<Uri> out = new ArrayList<>();
        ArrayList<Uri> list = IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri.class);
        if (list != null) {
            for (Uri u : list) {
                if (u != null) {
                    out.add(u);
                }
            }
        }
        if (out.isEmpty()) {
            ClipData clip = intent.getClipData();
            if (clip != null) {
                for (int i = 0; i < clip.getItemCount(); i++) {
                    Uri u = clip.getItemAt(i).getUri();
                    if (u != null) {
                        out.add(u);
                    }
                }
            }
        }
        return out;
    }

    private static Uri streamExtra(Intent intent) {
        Uri uri = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
        if (uri == null) {
            ClipData clip = intent.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                uri = clip.getItemAt(0).getUri();
            }
        }
        return uri;
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    private JSObject readDocument(Uri uri, String hintMime) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        byte[] bytes;
        try (InputStream in = resolver.openInputStream(uri)) {
            if (in == null) {
                throw new IOException("Unable to open " + uri);
            }
            bytes = readAll(in);
        }
        String name = queryDisplayName(uri);
        if (name == null || name.isEmpty()) {
            name = "Untitled";
        }
        JSObject ret = new JSObject();
        ret.put("uri", uri.toString());
        ret.put("name", name);
        ret.put("mime", resolveMime(resolver, uri, name, hintMime));
        ret.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
        return ret;
    }

    private void writeBytes(Uri uri, byte[] bytes) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        OutputStream stream = null;
        try {
            // "wt" truncates; not every provider supports it, so fall back to "w".
            stream = resolver.openOutputStream(uri, "wt");
        } catch (Exception e) {
            Log.w(TAG, "openOutputStream(\"wt\") failed, retrying with \"w\": " + e.getMessage());
        }
        if (stream == null) {
            stream = resolver.openOutputStream(uri, "w");
        }
        if (stream == null) {
            throw new IOException("Unable to open " + uri + " for writing");
        }
        try (OutputStream out = stream) {
            out.write(bytes);
            out.flush();
        }
    }

    private String queryDisplayName(Uri uri) {
        if (ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            try (
                Cursor cursor = getContext()
                    .getContentResolver()
                    .query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)
            ) {
                if (cursor != null && cursor.moveToFirst()) {
                    int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (index >= 0 && !cursor.isNull(index)) {
                        String name = cursor.getString(index);
                        if (name != null && !name.isEmpty()) {
                            return name;
                        }
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "Could not query display name for " + uri, e);
            }
        }
        String last = uri.getLastPathSegment();
        if (last == null) {
            return null;
        }
        int slash = last.lastIndexOf('/');
        return slash >= 0 ? last.substring(slash + 1) : last;
    }

    private static String resolveMime(ContentResolver resolver, Uri uri, String name, String hintMime) {
        String mime = null;
        try {
            mime = resolver.getType(uri);
        } catch (Exception ignored) {
            // Some providers throw for unknown URIs; fall through to the other strategies.
        }
        if (isSpecificMime(mime)) {
            return mime;
        }
        if (isSpecificMime(hintMime)) {
            return hintMime;
        }
        String fromExtension = mimeFromExtension(name);
        if (fromExtension != null) {
            return fromExtension;
        }
        return mime != null ? mime : "application/octet-stream";
    }

    private static boolean isSpecificMime(String mime) {
        return mime != null && !mime.isEmpty() && !"application/octet-stream".equals(mime) && !mime.contains("*");
    }

    private static String mimeFromExtension(String name) {
        if (name == null) {
            return null;
        }
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) {
            return null;
        }
        String ext = name.substring(dot + 1).toLowerCase(Locale.ROOT);
        switch (ext) {
            case "jpg": case "jpeg": case "jpe": case "jfif": return "image/jpeg";
            case "png": case "apng": return "image/png";
            case "gif": return "image/gif";
            case "webp": return "image/webp";
            case "avif": return "image/avif";
            case "heic": case "heif": case "hif": return "image/heic";
            case "jxl": return "image/jxl";
            case "bmp": case "dib": return "image/bmp";
            case "ico": return "image/x-icon";
            case "cur": return "image/x-icon";
            case "tif": case "tiff": return "image/tiff";
            case "svg": case "svgz": return "image/svg+xml";
            case "psd": return "image/vnd.adobe.photoshop";
            case "tga": return "image/x-tga";
            case "pdf": return "application/pdf";
            case "djvu": case "djv": return "image/vnd.djvu";
            case "pct": case "pict": return "image/x-pict";
            case "fpx": return "image/vnd.fpx";
            case "psp": case "pspimage": case "tub": return "image/x-paintshoppro";
            case "cdr": return "application/vnd.corel-draw";
            case "jbg": case "jbig": case "bie": return "image/jbig";
            case "dcm": case "dicom": return "application/dicom";
            case "fits": case "fit": case "fts": return "image/fits";
            case "ras": case "sun": case "im1": case "im8": case "im24": case "im32": return "image/x-sun-raster";
            case "sgi": case "rgb": case "rgba": case "bw": return "image/sgi";
            case "txt": return "text/plain";
            case "zip": case "cbz": return "application/zip";
            case "rar": case "cbr": return "application/vnd.rar";
            default:
                return null;
        }
    }

    private void takePersistablePermission(Uri uri) {
        if (!ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            return;
        }
        ContentResolver resolver = getContext().getContentResolver();
        try {
            resolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            );
        } catch (Exception e) {
            try {
                resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) {
                // Not a persistable grant (e.g. a one-off VIEW intent); access lasts for this session.
            }
        }
    }

    private static Uri resultUri(ActivityResult result) {
        List<Uri> uris = resultUris(result);
        return uris.isEmpty() ? null : uris.get(0);
    }

    /** Every URI an activity result carries (one, or several when EXTRA_ALLOW_MULTIPLE was set). */
    private static List<Uri> resultUris(ActivityResult result) {
        List<Uri> out = new ArrayList<>();
        if (result == null || result.getResultCode() != Activity.RESULT_OK) {
            return out;
        }
        Intent data = result.getData();
        if (data == null) {
            return out;
        }
        ClipData clip = data.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri u = clip.getItemAt(i).getUri();
                if (u != null) {
                    out.add(u);
                }
            }
        }
        if (out.isEmpty() && data.getData() != null) {
            out.add(data.getData());
        }
        return out;
    }

    private static Exception asException(Throwable t) {
        return t instanceof Exception ? (Exception) t : new Exception(t.toString(), t);
    }

    private static void resolveCanceled(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("canceled", true);
        call.resolve(ret);
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
        byte[] buffer = new byte[64 * 1024];
        int read;
        long total = 0;
        while ((read = in.read(buffer)) != -1) {
            total += read;
            if (total > MAX_READ_BYTES) {
                throw new IOException("File is larger than " + (MAX_READ_BYTES / (1024 * 1024)) + " MB");
            }
            out.write(buffer, 0, read);
        }
        return out.toByteArray();
    }

    private static byte[] decodeBase64(String data) {
        if (data == null) {
            return new byte[0];
        }
        // Tolerate a data: URL prefix ("data:<mime>;base64,....").
        int comma = data.startsWith("data:") ? data.indexOf(',') : -1;
        String payload = comma >= 0 ? data.substring(comma + 1) : data;
        return Base64.decode(payload, Base64.DEFAULT);
    }

    private static String[] toStringArray(JSArray array) {
        List<String> out = new ArrayList<>();
        if (array != null) {
            for (int i = 0; i < array.length(); i++) {
                Object value = array.opt(i);
                if (value instanceof String && !((String) value).isEmpty()) {
                    out.add((String) value);
                }
            }
        }
        return out.toArray(new String[0]);
    }

    private static String sanitizeFileName(String name) {
        String cleaned = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (cleaned.isEmpty() || ".".equals(cleaned) || "..".equals(cleaned)) {
            return "picture";
        }
        return cleaned;
    }

    private static void pruneOldShares(File dir) {
        File[] files = dir.listFiles();
        if (files == null) {
            return;
        }
        long cutoff = System.currentTimeMillis() - SHARE_FILE_MAX_AGE_MS;
        for (File f : files) {
            if (f.isFile() && f.lastModified() < cutoff && !f.delete()) {
                Log.w(TAG, "Could not delete old shared file " + f.getName());
            }
        }
    }
}
