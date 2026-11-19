defmodule Livecaption.MixProject do
  use Mix.Project

  def project do
    [app: :livecaption, version: "0.1.0", elixir: "~> 1.18", start_permanent: Mix.env() == :prod, deps: deps()]
  end

  def application, do: [extra_applications: [:logger], mod: {Livecaption.Application, []}]

  defp deps do
    [{:bandit, "~> 1.14.1"}, {:plug, "~> 1.20.3"}, {:websock_adapter, "~> 0.7.0"}]
  end
end
