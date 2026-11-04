// The prompt helper of Windows' OpenSSH (its SSH_ASKPASS), see src/main/askpass.ts.
//
// OpenSSH starts SSH_ASKPASS with CreateProcess and the prompt as its one argument, which a server
// partly chooses. A batch file went through cmd.exe, which reads that command line, prompt included,
// before the batch starts: `" & <command> & "` in a prompt ran the command. Electron itself writes a
// line break to stdout as it starts, which ssh read as an empty answer. Hence this executable: it
// sends the prompt to the app over its named pipe, with the app's secret, and prints the answer.
//
// Compiled by scripts/build-askpass.cjs with the C# compiler of the .NET Framework that Windows ships.
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Web.Script.Serialization;

static class AskPass
{
    const string PipePrefix = @"\\.\pipe\";

    static int Main(string[] args)
    {
        try
        {
            string pipe = Environment.GetEnvironmentVariable("GDG_ASKPASS_PIPE");
            string token = Environment.GetEnvironmentVariable("GDG_ASKPASS_TOKEN");
            if (pipe == null || token == null || !pipe.StartsWith(PipePrefix, StringComparison.OrdinalIgnoreCase)) return 1;

            var json = new JavaScriptSerializer();
            var utf8 = new UTF8Encoding(false);
            var request = new Dictionary<string, object> { { "prompt", string.Join(" ", args) }, { "token", token } };
            byte[] line = utf8.GetBytes(json.Serialize(request) + "\n");

            using (var client = new NamedPipeClientStream(".", pipe.Substring(PipePrefix.Length), PipeDirection.InOut))
            {
                client.Connect(10000);
                client.Write(line, 0, line.Length);
                client.Flush();
                string reply = new StreamReader(client, utf8).ReadToEnd();
                var answer = json.Deserialize<Dictionary<string, object>>(reply);
                object value;
                if (answer == null || !answer.TryGetValue("value", out value) || !(value is string)) return 1;
                byte[] output = utf8.GetBytes((string)value + "\n");
                using (Stream stdout = Console.OpenStandardOutput()) stdout.Write(output, 0, output.Length);
                return 0;
            }
        }
        catch
        {
            return 1;
        }
    }
}
