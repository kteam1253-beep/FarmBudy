import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, GitBranch, Github, Rocket, CheckCircle2, XCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface GitHubUser {
  login: string;
  avatar_url: string;
  html_url: string;
}

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  default_branch: string;
  private: boolean;
  pushed_at: string;
}

export default function DeployPage() {
  const { toast } = useToast();
  const [selectedRepo, setSelectedRepo] = useState<string>("");
  const [commitMessage, setCommitMessage] = useState<string>("");
  const [branch, setBranch] = useState<string>("main");

  const { data: user, isLoading: userLoading, error: userError } = useQuery<GitHubUser>({
    queryKey: ["/api/github/user"],
  });

  const { data: repos, isLoading: reposLoading } = useQuery<GitHubRepo[]>({
    queryKey: ["/api/github/repos"],
    enabled: !!user,
  });

  const pushMutation = useMutation({
    mutationFn: async (data: { owner: string; repo: string; message: string; branch: string }) => {
      const response = await apiRequest("POST", "/api/github/push", {
        owner: data.owner,
        repo: data.repo,
        files: [],
        message: data.message,
        branch: data.branch,
      });
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Push Successful",
        description: "Code pushed to GitHub. Railway will auto-deploy if connected.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Push Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handlePush = () => {
    if (!selectedRepo || !commitMessage) {
      toast({
        title: "Missing Information",
        description: "Please select a repository and enter a commit message.",
        variant: "destructive",
      });
      return;
    }

    const [owner, repo] = selectedRepo.split("/");
    pushMutation.mutate({ owner, repo, message: commitMessage, branch });
  };

  if (userLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (userError) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-destructive" />
              GitHub Not Connected
            </CardTitle>
            <CardDescription>
              Please connect your GitHub account to enable deployment features.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Deploy</h1>
          <p className="text-muted-foreground">Push updates to GitHub for Railway deployment</p>
        </div>
        {user && (
          <a 
            href={user.html_url} 
            target="_blank" 
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
            data-testid="link-github-profile"
          >
            <img src={user.avatar_url} alt={user.login} className="w-8 h-8 rounded-full" />
            <span>@{user.login}</span>
          </a>
        )}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Github className="h-5 w-5" />
              GitHub Connection
            </CardTitle>
            <CardDescription>Your GitHub account is connected</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-500" />
              <span>Connected as <strong>{user?.login}</strong></span>
            </div>
            {repos && (
              <div className="text-sm text-muted-foreground">
                {repos.length} repositories available
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Rocket className="h-5 w-5" />
              Railway Deployment
            </CardTitle>
            <CardDescription>Auto-deploy when code is pushed to GitHub</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Connect your Railway project to your GitHub repository. 
              When you push code, Railway will automatically build and deploy.
            </p>
            <a 
              href="https://railway.app/dashboard" 
              target="_blank" 
              rel="noopener noreferrer"
              className="mt-4 inline-block"
              data-testid="link-railway-dashboard"
            >
              <Button variant="outline" size="sm">
                Open Railway Dashboard
              </Button>
            </a>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitBranch className="h-5 w-5" />
            Push to GitHub
          </CardTitle>
          <CardDescription>
            Select a repository and push your latest changes
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="repo">Repository</Label>
              <Select value={selectedRepo} onValueChange={setSelectedRepo}>
                <SelectTrigger id="repo" data-testid="select-repository">
                  <SelectValue placeholder="Select a repository" />
                </SelectTrigger>
                <SelectContent>
                  {reposLoading ? (
                    <SelectItem value="loading" disabled>Loading...</SelectItem>
                  ) : repos?.map((repo) => (
                    <SelectItem key={repo.id} value={repo.full_name}>
                      <div className="flex items-center gap-2">
                        <span>{repo.name}</span>
                        {repo.private && <Badge variant="secondary">Private</Badge>}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="branch">Branch</Label>
              <Input 
                id="branch"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="main"
                data-testid="input-branch"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="message">Commit Message</Label>
            <Textarea 
              id="message"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="Describe your changes..."
              rows={3}
              data-testid="input-commit-message"
            />
          </div>

          <Button 
            onClick={handlePush}
            disabled={pushMutation.isPending || !selectedRepo || !commitMessage}
            className="w-full"
            data-testid="button-push-to-github"
          >
            {pushMutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Pushing...
              </>
            ) : (
              <>
                <Rocket className="mr-2 h-4 w-4" />
                Push & Deploy
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {repos && repos.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Your Repositories</CardTitle>
            <CardDescription>Recently updated repositories</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {repos.slice(0, 5).map((repo) => (
                <div 
                  key={repo.id} 
                  className="flex items-center justify-between p-3 rounded-lg bg-muted/50"
                  data-testid={`repo-item-${repo.id}`}
                >
                  <div className="flex items-center gap-3">
                    <Github className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <a 
                        href={repo.html_url} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="font-medium hover:underline"
                      >
                        {repo.name}
                      </a>
                      <p className="text-sm text-muted-foreground">
                        {repo.default_branch} branch
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {repo.private && <Badge variant="secondary">Private</Badge>}
                    <span className="text-xs text-muted-foreground">
                      {new Date(repo.pushed_at).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
