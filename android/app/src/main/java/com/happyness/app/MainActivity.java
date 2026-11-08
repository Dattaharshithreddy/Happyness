package com.happyness.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Happyness for Android.
 *
 * The UI is the same web app as the website (bundled into the APK as assets),
 * shown in a WebView. Because the app runs on its own, it reads the good-news
 * feeds directly: JavaScript asks {@link NativeBridge#fetchText} to download a
 * feed, and the joy filter runs on the phone.
 */
public class MainActivity extends Activity {

    private static final String START_URL = "file:///android_asset/www/index.html";
    private static final int MAX_BYTES = 5 * 1024 * 1024;
    private static final int TIMEOUT_MS = 15000;

    private WebView webView;
    private final ExecutorService network = Executors.newFixedThreadPool(4);

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        int bg = Color.parseColor(isNight() ? "#1d1a16" : "#fff8ec");
        webView = new WebView(this);
        webView.setBackgroundColor(bg);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        // The root view paints behind the status/navigation bars, and pads the
        // WebView so content never sits under them or under the keyboard.
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(bg);
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        applyEdgeToEdge(root);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // localStorage: settings, your posts, feed cache
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setUserAgentString(s.getUserAgentString() + " Happyness/" + BuildConfig.VERSION_NAME);

        webView.addJavascriptInterface(new NativeBridge(), "HappyNative");
        webView.setWebChromeClient(new WebChromeClient()); // enables confirm() dialogs
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return openExternally(request.getUrl());
            }
        });

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(START_URL);
        }
    }

    /**
     * Android 15+ draws apps edge-to-edge when they target API 35 or newer.
     * On Android 11+ we opt in everywhere and pad for the system bars, display
     * cutout and keyboard ourselves. Older versions keep the classic layout
     * (the system fits the window and adjustResize handles the keyboard).
     */
    private void applyEdgeToEdge(View root) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;
        getWindow().setDecorFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsets.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return WindowInsets.CONSUMED;
        });
        root.requestApplyInsets();
    }

    /** Story links open in the user's browser, never inside the app. */
    private boolean openExternally(Uri uri) {
        String scheme = uri.getScheme();
        if ("file".equals(scheme)) return false; // our own bundled pages
        if ("http".equals(scheme) || "https".equals(scheme) || "mailto".equals(scheme)) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException ignored) {
                // no browser installed; nothing to do
            }
        }
        return true; // block everything else
    }

    private boolean isNight() {
        int mode = getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK;
        return mode == android.content.res.Configuration.UI_MODE_NIGHT_YES;
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        // Let the page close an open sheet first.
        // Then go back from a legal page to the feed; otherwise leave the app.
        webView.evaluateJavascript("window.happyBack ? window.happyBack() : false", value -> {
            if ("true".equals(value)) return;
            if (webView.canGoBack()) webView.goBack();
            else MainActivity.super.onBackPressed();
        });
    }

    @Override
    protected void onDestroy() {
        network.shutdownNow();
        if (webView != null) {
            webView.removeJavascriptInterface("HappyNative");
            webView.destroy();
        }
        super.onDestroy();
    }

    /** Methods callable from JavaScript as window.HappyNative.*. */
    private class NativeBridge {

        /**
         * Download a feed (https only) on a background thread and hand the text
         * back via window.__happyNativeDone(id, ok, body).
         */
        @JavascriptInterface
        public void fetchText(final String id, final String url) {
            network.execute(() -> {
                boolean ok = false;
                String body;
                try {
                    body = download(url);
                    ok = true;
                } catch (Exception e) {
                    body = String.valueOf(e.getMessage());
                }
                final String js = "window.__happyNativeDone && window.__happyNativeDone("
                        + JSONObject.quote(id) + "," + ok + "," + JSONObject.quote(body) + ")";
                runOnUiThread(() -> {
                    if (!isFinishing() && !isDestroyed()) webView.evaluateJavascript(js, null);
                });
            });
        }
    }

    private static String download(String address) throws Exception {
        URL url = new URL(address);
        for (int redirects = 0; redirects < 5; redirects++) {
            if (!"https".equals(url.getProtocol())) throw new SecurityException("https only");
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setInstanceFollowRedirects(false);
            conn.setRequestProperty("User-Agent", "Happyness/" + BuildConfig.VERSION_NAME + " (Android; uplifting news reader)");
            conn.setRequestProperty("Accept", "application/rss+xml, application/atom+xml, application/xml, text/xml");
            try {
                int code = conn.getResponseCode();
                if (code >= 300 && code < 400) {
                    String location = conn.getHeaderField("Location");
                    if (location == null) throw new Exception("redirect without location");
                    url = new URL(url, location);
                    continue;
                }
                if (code != 200) throw new Exception("HTTP " + code);
                try (InputStream in = conn.getInputStream()) {
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        out.write(buf, 0, n);
                        if (out.size() > MAX_BYTES) throw new Exception("feed too large");
                    }
                    return new String(out.toByteArray(), StandardCharsets.UTF_8);
                }
            } finally {
                conn.disconnect();
            }
        }
        throw new Exception("too many redirects");
    }
}
