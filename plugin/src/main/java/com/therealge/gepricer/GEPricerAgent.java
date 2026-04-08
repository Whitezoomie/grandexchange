package com.therealge.gepricer;

import java.io.File;
import java.io.FileWriter;
import java.io.PrintWriter;
import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.Field;
import java.net.URL;
import java.net.URLClassLoader;
import java.security.ProtectionDomain;
import java.util.jar.JarFile;

public class GEPricerAgent {
    private static volatile boolean done = false;

    public static void premain(String agentArgs, Instrumentation inst) throws Exception {
        final File jar = new File(agentArgs);
        final File logFile = new File(System.getProperty("user.home") + "\\.runelite\\agent-debug.txt");
        final long pid = ProcessHandle.current().pid();

        inst.appendToSystemClassLoaderSearch(new JarFile(jar));

        try (PrintWriter log = new PrintWriter(new FileWriter(logFile, true))) {
            log.println("=== premain pid=" + pid + " ===");
        }

        final URL jarUrl = jar.toURI().toURL();
        final long outerPid = pid;

        // Install a ClassFileTransformer. When the JVM loads ExternalPluginManager
        // (during Guice setup in the client JVM), the transformer fires synchronously
        // on the loading thread. We capture the classloader at that instant and
        // immediately dispatch a thread to set builtinExternals before
        // ExternalPluginManager.loadExternalPlugins() is invoked.
        inst.addTransformer(new ClassFileTransformer() {
            @Override
            public byte[] transform(ClassLoader loader,
                                    String className,
                                    Class<?> classBeingRedefined,
                                    ProtectionDomain protectionDomain,
                                    byte[] classfileBuffer) {
                if (done) return null;
                if (!"net/runelite/client/externalplugins/ExternalPluginManager".equals(className))
                    return null;
                if (loader == null) return null;

                done = true;
                writeLog(logFile, "pid=" + outerPid + " EPM transform fired loader=" + loader.getClass().getName());

                final ClassLoader rl = loader;
                Thread t = new Thread(() -> {
                    try {
                        // The class definition completes after transform() returns.
                        // A short sleep ensures it is fully defined before we load it.
                        Thread.sleep(20);

                        Class<?> epm = rl.loadClass(
                                "net.runelite.client.externalplugins.ExternalPluginManager");
                        writeLog(logFile, "pid=" + outerPid + " EPM loaded OK");

                        // Child classloader: RuneLite URL CL as parent so all
                        // RuneLite types used by GEPricerPlugin resolve correctly.
                        URLClassLoader pluginLoader = new URLClassLoader(new URL[]{jarUrl}, rl);
                        Class<?> pluginClass = pluginLoader.loadClass(
                                "com.therealge.gepricer.GEPricerPlugin");
                        writeLog(logFile, "pid=" + outerPid + " GEPricerPlugin loaded OK");

                        // Set builtinExternals directly via reflection — avoids
                        // the -ea assertion check inside loadBuiltin().
                        Field f = epm.getDeclaredField("builtinExternals");
                        f.setAccessible(true);
                        f.set(null, new Class<?>[]{pluginClass});
                        writeLog(logFile, "pid=" + outerPid + " builtinExternals set SUCCESS");
                    } catch (Throwable ex) {
                        writeLog(logFile, "pid=" + outerPid + " EXCEPTION: " + ex);
                        for (StackTraceElement el : ex.getStackTrace())
                            writeLog(logFile, "  at " + el);
                    }
                }, "ge-sideload");
                t.setDaemon(true);
                t.start();

                return null; // do not modify class bytes
            }
        }, false);
    }

    private static void writeLog(File logFile, String msg) {
        try (PrintWriter log = new PrintWriter(new FileWriter(logFile, true))) {
            log.println(msg);
        } catch (Exception ignored) {}
    }
}
